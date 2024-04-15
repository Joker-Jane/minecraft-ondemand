import {Stack, StackProps} from "aws-cdk-lib";
import {Construct} from "constructs";
import {StackConfig} from "./types";

interface EC2Props extends StackProps {
    config: Readonly<StackConfig>;
}

export class EC2Stack extends Stack {
    constructor(scope: Construct, id: string, props: EC2Props) {
        super(scope, id, props);

        const { config } = props;


    }
}