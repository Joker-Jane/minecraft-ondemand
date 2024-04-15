#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { MinecraftStack } from '../lib/minecraft-stack';
import { DomainStack } from '../lib/domain-stack';
import { constants } from '../lib/constants';
import { resolveConfig } from '../lib/config';

const app = new cdk.App();

const config = resolveConfig();

if (!config.domainName) {
  throw new Error('Missing required `DOMAIN_NAME` in .env file, please specify domain name');
}

if (!config.domainName) {
  throw new Error('Missing required `SUBDOMAIN_PART` in .env file, please specify subdomain name.');
}

if (!config.domainName) {
  throw new Error('Missing required `SERVER_REGION` in .env file, example: us-east-1.');
}

const domainStack = new DomainStack(app, 'minecraft-domain-stack', {
  env: {
    /**
     * Because we are relying on Route 53+CloudWatch to invoke the Lambda function,
     * it _must_ reside in the N. Virginia (us-east-1) region.
     */
    region: constants.DOMAIN_STACK_REGION,
    /* Account must be specified to allow for hosted zone lookup */
    account: process.env.CDK_DEFAULT_ACCOUNT,
  },
  config,
});

const minecraftStack = new MinecraftStack(app, 'minecraft-server-stack', {
  env: {
    region: config.serverRegion,
    /* Account must be specified to allow for VPC lookup */
    account: process.env.CDK_DEFAULT_ACCOUNT,
  },
  config,
});

minecraftStack.addDependency(domainStack);
