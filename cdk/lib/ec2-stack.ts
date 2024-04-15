import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import {Construct} from 'constructs';
import {Stack, StackProps} from 'aws-cdk-lib';

interface EC2StackProps extends StackProps {
    vpc: ec2.Vpc;
    fileSystem: efs.FileSystem;
}

export class EC2Stack extends Stack {
    constructor(scope: Construct, id: string, props: EC2StackProps) {
        super(scope, id, props);

        // Reuse the existing VPC and EFS filesystem
        const {vpc, fileSystem} = props;

        // Define the security group for the EC2 instance
        const securityGroup = new ec2.SecurityGroup(this, 'MinecraftServerSecurityGroup', {
            vpc,
            description: 'Security group for the Minecraft server EC2 instance',
            allowAllOutbound: true   // Modify as needed for stricter outbound rules
        });

        // Allow inbound SSH access (optional, remove if not needed)
        securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'Allow SSH access');

        // Create the EC2 instance
        const instance = new ec2.Instance(this, 'MinecraftServerInstance', {
            instanceType: new ec2.InstanceType('t2.micro'),
            machineImage: new ec2.AmazonLinuxImage(), // Default is latest Amazon Linux
            vpc,
            vpcSubnets: {
                subnetType: ec2.SubnetType.PUBLIC, // Use one of the public subnets
            },
            securityGroup,
            keyName: undefined, // No keypair specified
            blockDevices: [
                {
                    deviceName: '/dev/sdh',
                    volume: ec2.BlockDeviceVolume.ebs(8, {
                        volumeType: ec2.EbsDeviceVolumeType.GP3
                    }),
                },
            ]
        });

        // Mount the EFS to the EC2 instance at /home/ec2-user/data
        const accessPoint = new efs.AccessPoint(this, 'AccessPoint', {
            fileSystem,
            path: '/home/ec2-user/data',
            posixUser: {
                uid: '1000',
                gid: '1000'
            },
            createAcl: {
                ownerUid: '1000',
                ownerGid: '1000',
                permissions: '755'
            }
        });

        fileSystem.connections.allowDefaultPortFrom(securityGroup);

        // Add the EFS mount instructions to the EC2 instance UserData
        instance.userData.addCommands(
            'yum install -y amazon-efs-utils',
            'yum install -y nfs-utils',
            'file-system-id.efs.aws-region.amazonaws.com:/   /home/ec2-user/data   efs   defaults,_netdev   0   0',
            `echo "${fileSystem.fileSystemId}.efs.${this.region}.amazonaws.com:/ ${accessPoint.accessPointId} efs tls,_netdev" >> /etc/fstab`,
            'mount -a'
        );
    }
}
