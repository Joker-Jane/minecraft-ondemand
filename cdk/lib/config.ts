import * as dotenv from 'dotenv';
import * as path from 'path';
import { MinecraftImageEnv, StackConfig } from './types';
import { stringAsBoolean } from './util';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const resolveMinecraftEnvVars = (json = ''): MinecraftImageEnv => {
  const defaults = { EULA: 'TRUE' };
  try {
    return {
      ...defaults,
      ...JSON.parse(json),
    };
  } catch (e) {
    throw new Error('Unable to resolve .env value for MINECRAFT_IMAGE_ENV_VARS_JSON.');
  }
};

export const resolveConfig = (): StackConfig => ({
  domainName: process.env.DOMAIN_NAME || '',
  subdomainPart: process.env.SUBDOMAIN_PART || '',
  serverRegion: process.env.SERVER_REGION || '',
  minecraftEdition:
    process.env.MINECRAFT_EDITION === 'bedrock' ? 'bedrock' : 'java',
  shutdownMinutes: process.env.SHUTDOWN_MINUTES || '30',
  startupMinutes: process.env.STARTUP_MINUTES || '10',
  useFargateSpot: stringAsBoolean(process.env.USE_FARGATE_SPOT) || true,
  taskCpu: +(process.env.TASK_CPU || 8192),
  taskMemory: +(process.env.TASK_MEMORY || 2048),
  vpcId: process.env.VPC_ID || '',
  minecraftImageEnv: resolveMinecraftEnvVars(
    process.env.MINECRAFT_IMAGE_ENV_VARS_JSON
  ),
  snsEmailAddress: process.env.SNS_EMAIL_ADDRESS || '',
  twilio: {
    phoneFrom: process.env.TWILIO_PHONE_FROM || '',
    phoneTo: process.env.TWILIO_PHONE_TO || '',
    accountId: process.env.TWILIO_ACCOUNT_ID || '',
    authCode: process.env.TWILIO_AUTH_CODE || '',
  },
  clusterName: process.env.CLUSTER_NAME || `minecraft-server-${process.env.SUBDOMAINPART}`,
  serviceName: process.env.SERVICE_NAME || 'minecraft-server',
  serverContainerName: process.env.SERVER_CONTAINER_NAME || 'minecraft-server',
  ecsVolumeName: process.env.ECS_VOLUME_NAME || `minecraft-server-${process.env.SUBDOMAINPART}-data`,
  debug: stringAsBoolean(process.env.DEBUG) || false,
});
