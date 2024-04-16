import * as path from 'path';
import {
    Arn,
    ArnFormat,
    aws_ec2 as ec2,
    aws_ecs as ecs,
    aws_efs as efs,
    aws_iam as iam,
    aws_logs as logs,
    aws_sns as sns,
    RemovalPolicy,
    Stack,
    StackProps,
} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import {constants} from './constants';
import {SSMParameterReader} from './ssm-parameter-reader';
import {StackConfig} from './types';
import {getMinecraftServerConfig, isDockerInstalled} from './util';
import {Port} from "aws-cdk-lib/aws-ec2";

interface MinecraftStackProps extends StackProps {
    config: Readonly<StackConfig>;
}

export class MinecraftStack extends Stack {
    constructor(scope: Construct, id: string, props: MinecraftStackProps) {
        super(scope, id, props);

        const {config} = props;

        const vpc = config.vpcId
            ? ec2.Vpc.fromLookup(this, 'Vpc', {vpcId: config.vpcId})
            : new ec2.Vpc(this, 'Vpc', {
                maxAzs: 3,
                natGateways: 0,
            });

        const fileSystem = new efs.FileSystem(this, 'FileSystem', {
            vpc,
            removalPolicy: RemovalPolicy.SNAPSHOT,
        });

        const accessPoint = new efs.AccessPoint(this, 'AccessPoint', {
            fileSystem,
            path: '/minecraft',
            posixUser: {
                uid: '1000',
                gid: '1000',
            },
            createAcl: {
                ownerGid: '1000',
                ownerUid: '1000',
                permissions: '0755',
            },
        });

        const efsReadWriteDataPolicy = new iam.Policy(this, 'DataRWPolicy', {
            statements: [
                new iam.PolicyStatement({
                    sid: 'AllowReadWriteOnEFS',
                    effect: iam.Effect.ALLOW,
                    actions: [
                        'elasticfilesystem:ClientMount',
                        'elasticfilesystem:ClientWrite',
                        'elasticfilesystem:DescribeFileSystems',
                    ],
                    resources: [fileSystem.fileSystemArn],
                    conditions: {
                        StringEquals: {
                            'elasticfilesystem:AccessPointArn': accessPoint.accessPointArn,
                        },
                    },
                }),
            ],
        });

        const ecsTaskRole = new iam.Role(this, 'TaskRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            description: 'Minecraft ECS task role',
        });

        efsReadWriteDataPolicy.attachToRole(ecsTaskRole);

        const cluster = new ecs.Cluster(this, 'Cluster', {
            clusterName: `minecraft-server-${config.subdomainPart}`,
            vpc,
            containerInsights: true,
            enableFargateCapacityProviders: true,
        });

        const taskDefinition = new ecs.FargateTaskDefinition(
            this,
            'TaskDefinition',
            {
                taskRole: ecsTaskRole,
                memoryLimitMiB: config.taskMemory,
                cpu: config.taskCpu,
                volumes: [
                    {
                        name: `minecraft-server-${config.subdomainPart}-data`,
                        efsVolumeConfiguration: {
                            fileSystemId: fileSystem.fileSystemId,
                            transitEncryption: 'ENABLED',
                            authorizationConfig: {
                                accessPointId: accessPoint.accessPointId,
                                iam: 'ENABLED',
                            },
                        },
                    },
                ],
            }
        );

        const minecraftServerConfig = getMinecraftServerConfig(
            config.minecraftEdition
        );

        const minecraftServerContainer = new ecs.ContainerDefinition(
            this,
            'ServerContainer',
            {
                containerName: 'minecraft-server',
                image: ecs.ContainerImage.fromRegistry(minecraftServerConfig.image),
                portMappings: [
                    {
                        containerPort: minecraftServerConfig.port,
                        hostPort: minecraftServerConfig.port,
                        protocol: minecraftServerConfig.protocol,
                    },
                ],
                environment: config.minecraftImageEnv,
                essential: false,
                taskDefinition,
                logging: config.debug
                    ? new ecs.AwsLogDriver({
                        logRetention: logs.RetentionDays.THREE_DAYS,
                        streamPrefix: 'minecraft-server',
                    })
                    : undefined,
            }
        );

        minecraftServerContainer.addMountPoints({
            containerPath: '/data',
            sourceVolume: `minecraft-server-${config.subdomainPart}-data`,
            readOnly: false,
        });

        const serviceSecurityGroup = new ec2.SecurityGroup(
            this,
            'ServiceSecurityGroup',
            {
                vpc,
                description: 'Security group for Minecraft on-demand',
            }
        );

        serviceSecurityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            minecraftServerConfig.ingressRulePort
        );

        const minecraftServerService = new ecs.FargateService(
            this,
            'FargateService',
            {
                cluster,
                capacityProviderStrategies: [
                    {
                        capacityProvider: config.useFargateSpot
                            ? 'FARGATE_SPOT'
                            : 'FARGATE',
                        weight: 1,
                        base: 1,
                    },
                ],
                taskDefinition: taskDefinition,
                platformVersion: ecs.FargatePlatformVersion.LATEST,
                serviceName: 'minecraft-server',
                desiredCount: 0,
                assignPublicIp: true,
                securityGroups: [serviceSecurityGroup],
            }
        );

        /* Allow access to EFS from Fargate service security group */
        fileSystem.connections.allowDefaultPortFrom(
            minecraftServerService.connections
        );

        const hostedZoneId = new SSMParameterReader(
            this,
            'Route53HostedZoneIdReader',
            {
                parameterName: `MinecraftHostedZoneID-${config.subdomainPart}`,
                region: constants.DOMAIN_STACK_REGION,
            }
        ).getParameterValue();

        let snsTopicArn = '';
        /* Create SNS Topic if SNS_EMAIL is provided */
        if (config.snsEmailAddress) {
            const snsTopic = new sns.Topic(this, 'ServerSnsTopic', {
                displayName: 'Minecraft Server Notifications',
            });

            snsTopic.grantPublish(ecsTaskRole);

            const emailSubscription = new sns.Subscription(
                this,
                'EmailSubscription',
                {
                    protocol: sns.SubscriptionProtocol.EMAIL,
                    topic: snsTopic,
                    endpoint: config.snsEmailAddress,
                }
            );
            snsTopicArn = snsTopic.topicArn;
        }

        const watchdogContainer = new ecs.ContainerDefinition(
            this,
            'WatchDogContainer',
            {
                containerName: constants.WATCHDOG_SERVER_CONTAINER_NAME,
                image: isDockerInstalled()
                    ? ecs.ContainerImage.fromAsset(
                        path.resolve(__dirname, '../../minecraft-ecsfargate-watchdog/')
                    )
                    : ecs.ContainerImage.fromRegistry(
                        'doctorray/minecraft-ecsfargate-watchdog'
                    ),
                essential: true,
                taskDefinition: taskDefinition,
                environment: {
                    CLUSTER: `minecraft-server-${config.subdomainPart}`,
                    SERVICE: 'minecraft-server',
                    DNSZONE: hostedZoneId,
                    SERVERNAME: `${config.subdomainPart}.${config.domainName}`,
                    SNSTOPIC: snsTopicArn,
                    TWILIOFROM: config.twilio.phoneFrom,
                    TWILIOTO: config.twilio.phoneTo,
                    TWILIOAID: config.twilio.accountId,
                    TWILIOAUTH: config.twilio.authCode,
                    STARTUPMIN: config.startupMinutes,
                    SHUTDOWNMIN: config.shutdownMinutes,
                },
                logging: config.debug
                    ? new ecs.AwsLogDriver({
                        logRetention: logs.RetentionDays.THREE_DAYS,
                        streamPrefix: constants.WATCHDOG_SERVER_CONTAINER_NAME,
                    })
                    : undefined,
            }
        );

        const serviceControlPolicy = new iam.Policy(this, `ServiceControlPolicy`, {
            statements: [
                new iam.PolicyStatement({
                    sid: 'AllowAllOnServiceAndTask',
                    effect: iam.Effect.ALLOW,
                    actions: ['ecs:*'],
                    resources: [
                        minecraftServerService.serviceArn,
                        /* arn:aws:ecs:<region>:<account_number>:task/minecraft/* */
                        Arn.format(
                            {
                                service: 'ecs',
                                resource: 'task',
                                resourceName: `minecraft-server-${config.subdomainPart}/*`,
                                arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
                            },
                            this
                        ),
                    ],
                }),
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ['ec2:DescribeNetworkInterfaces'],
                    resources: ['*'],
                }),
            ],
        });

        serviceControlPolicy.attachToRole(ecsTaskRole);

        /**
         * Add service control policy to the launcher lambda from the other stack
         */
        const launcherLambdaRoleArn = new SSMParameterReader(
            this,
            'launcherLambdaRoleArn',
            {
                parameterName: `LauncherLambdaRoleArn-${config.subdomainPart}`,
                region: constants.DOMAIN_STACK_REGION,
            }
        ).getParameterValue();
        const launcherLambdaRole = iam.Role.fromRoleArn(
            this,
            `LauncherLambdaRole`,
            launcherLambdaRoleArn
        );

        serviceControlPolicy.attachToRole(launcherLambdaRole);

        /**
         * This policy gives permission to our ECS task to update the A record
         * associated with our minecraft server. Retrieve the hosted zone identifier
         * from Route 53 and place it in the Resource line within this policy.
         */
        const iamRoute53Policy = new iam.Policy(this, 'IamRoute53Policy', {
            statements: [
                new iam.PolicyStatement({
                    sid: 'AllowEditRecordSets',
                    effect: iam.Effect.ALLOW,
                    actions: [
                        'route53:GetHostedZone',
                        'route53:ChangeResourceRecordSets',
                        'route53:ListResourceRecordSets',
                    ],
                    resources: [`arn:aws:route53:::hostedzone/${hostedZoneId}`],
                }),
            ],
        });
        iamRoute53Policy.attachToRole(ecsTaskRole);

        const ec2SecurityGroup = new ec2.SecurityGroup(this, 'MinecraftServerSecurityGroup', {
            vpc,
            description: 'Security group for Minecraft server EC2 instance',
            allowAllOutbound: true,
        });
        ec2SecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'Allow SSH access');

        const userData = ec2.UserData.forLinux();
        userData.addCommands(
            'yum install -y amazon-efs-utils',
            'yum install -y nfs-utils',
            'mkdir -p /home/ec2-user/data',
            `echo "${fileSystem.fileSystemId}.efs.${this.region}.amazonaws.com:/ /home/ec2-user/data efs defaults,_netdev 0 0" >> /etc/fstab`,
            'mount -a'
        );

        const ec2Role = new iam.Role(this, 'EC2Role', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            description: 'Minecraft EC2 data server role',
        });

        ec2Role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3ReadOnlyAccess'));

        const ec2Instance = new ec2.Instance(this, 'MinecraftServerInstance', {
            instanceName: `${config.subdomainPart}-data`,
            instanceType: new ec2.InstanceType('t2.micro'),
            machineImage: new ec2.AmazonLinuxImage({
                generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2
            }),
            role: ec2Role,
            vpc,
            vpcSubnets: {
                subnetType: ec2.SubnetType.PUBLIC
            },
            securityGroup: ec2SecurityGroup,
            blockDevices: [{
                deviceName: '/dev/xvda',
                volume: ec2.BlockDeviceVolume.ebs(8, {volumeType: ec2.EbsDeviceVolumeType.GP3}),
            }],
            userData: userData,
        });

        ec2Instance.connections.allowFrom(fileSystem.connections, Port.tcp(2049));
        fileSystem.connections.allowDefaultPortFrom(ec2Instance.connections)
    }
}