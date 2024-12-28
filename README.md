# 基于智能搜索方案Release3.3.0版本AppSync Private Search手动部署向导

Copyright © [Amazon.com](http://amazon.com/) and Affiliates: This deliverable is considered Developed Content as defined in the AWS Service Terms and the SOW between the parties dated [date].

## 背景

按照基于AWS "[下一代智能搜索和知识库解决方案指南](https://aws.amazon.com/cn/solutions/guidance/custom-search-of-an-enterprise-knowledge-base-on-aws/?did=sl_card&trk=sl_card)" Release3.3.0提供的方案和代码，该方案用API Gateway实现了Websocket API流式输出，但是目前API Gateway WebSocket API不支持通过VPC Private Endpoint的方式在VPC内部访问在VPC内部访问。AppSync服务提供的WebSocket API可以实现在VPC内部访问的Private Search API。


## 方案时序图

[Image: image.png]
## **1. 配置 AppSync**

### **1.1 为 AppSync 创建 VPC Endpoint**

进入 VPC 控制台，选择 Endpoints -> Create endpoint，创建步骤如下
首先为 endpoint 取名，Service category请选择**AWS services**，Services请选择**com.amazonaws.your-region.appsync-api**
[Image: Image.jpg]
VPC 选择 smart search 方案所在的 VPC，子网根据实际情况选择，此处选择了私有子网
[Image: Image.jpg]
选择合适的安全组，Policy 可保持默认，检查无误后点击 Create 创建
[Image: Image.jpg]

### **1.2 在 AppSync 创建 Private WebSocket API**


访问 AppSync 控制台，点击 APIs -> Create an API，具体步骤如下所示
[Image: Image.jpg][Image: Image.jpg][Image: Image.jpg][Image: Image.jpg]创建完成后，进入Settings，可以复制GraphQL endpoint（Appsync endpoint），和Real-time endpoint 后面的步骤需要用到
[Image: image.png]以及API Key
[Image: image.png]
## **2. 部署新的 lambda function**

### **2.1 部署新的private_search lambda function**

创建新的Lambda function，runtime选择Python 3.9
[Image: image.png]选择创建新的Role
[Image: image.png]Enable VPC，根据情况选择VPC，子网和安全组
[Image: image.png]修改这个Lambda执行Role的权限：
[Image: image.png]添加两条权限策略：1. 添加AmazonDynamoDBFullAccess策略文档 2. 添加如下内联策略：

```
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Action": [
                "apigateway:*",
                "dynamodb:*",
                "ec2:CreateNetworkInterface",
                "ec2:DeleteNetworkInterface",
                "ec2:DescribeNetworkInterfaces",
                "lambda:*",
                "logs:*"
            ],
            "Resource": "*",
            "Effect": "Allow"
        }
    ]
}
```

[Image: image.png]
回到Lambda服务，在Code的lambda_function.py中添加如下代码：

```
import json
import os
import logging
import boto3
import sys

logger = logging.getLogger()
logger.setLevel(logging.DEBUG)

dynamodb = boto3.resource('dynamodb')
lam = boto3.client('lambda')
connections = dynamodb.Table(os.environ['TABLE_NAME'])

def lambda_handler(event, context):
    if 'httpMethod' in event and event['httpMethod'] == 'OPTIONS':
        response = {
            "statusCode": 200,
            "headers": {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type"
            },
            "body": json.dumps("")
        }
        return response
    logger.debug("private-search: %s" % event)

    # for private search, connection id is retrieved from the request header
    # and MUST starts with 'private'
    connectionId = event.get('headers',{}).get('connectionId')
    if connectionId is None or not connectionId.startswith('private'):
        return { 'statusCode': 400, 
                 'body': 'bad request' }
    # set back to event to mock as an APIGateway WebSocket event
    event.get('requestContext', {})['connectionId'] = connectionId

    # store in ddb
    result = connections.put_item(Item={ 'id': connectionId})
    if result.get('ResponseMetadata',{}).get('HTTPStatusCode') != 200:
        return { 'statusCode': 500,
                 'body': 'something went wrong' }

    # invoke processor
    _function_name = 'langchain_processor_qa'
    try:
        lam.invoke(
            FunctionName=_function_name,
            InvocationType="Event",
            Payload=json.dumps(event)
        )
        return {
            'statusCode': 200,
            "headers": {
                "Access-Control-Allow-Origin": "*",  # 允许所有来源
                "Access-Control-Allow-Headers": "Content-Type"
            },
            'body': "200"
        }
    except Exception as e:
        print(e)
```

Timeout修改为1分钟：
[Image: image.png]添加环境变量TABLE_NAME，在Dynamodb服务中找到前缀为LambdaVPCStack-websocket的表名：
[Image: image.png]最后Deploy部署这个Lambda。


### **2.2 修改现有的 langchain_processor_qa Lambda function**

修改Lambda langchain_processor_qa的入口lambda_function.py，添加了对 AppSync private websocket api 的支持，如下图。
[Image: image.png]在如上图位置添加如下代码：

```
import requests
APPSYNC_ENDPOINT = os.environ.get('APPSYNC_ENDPOINT')
APPSYNC_API_KEY = os.environ.get('APPSYNC_API_KEY')
```


[Image: image.png]如上图在sendWebSocket函数中添加如下代码，注意格式缩进

```
            if connectionId.startswith('private'):
                api_res = requests.post(APPSYNC_ENDPOINT, headers = { 'x-api-key': APPSYNC_API_KEY }, json = {
                    "query":"mutation PublishData($name: String!, $data: AWSJSON!) { publish(name: $name, data: $data) { name data } }",
                    "variables": {
                        "name": connectionId,
                        "data": response['body'],
                    }
                })
                print('api_res', api_res)
                return
```

* * *
修改streaming_callback_handler.py

[Image: image.png]如上图位置添加如下代码

```
import requests
import os
APPSYNC_ENDPOINT = os.environ.get('APPSYNC_ENDPOINT')
APPSYNC_API_KEY = os.environ.get('APPSYNC_API_KEY')
```

[Image: image.png]如上图位置添加如下代码，注意缩进：

```
        if self.connectionId.startswith('private'):
            api_res = requests.post(APPSYNC_ENDPOINT, headers = { 'x-api-key': APPSYNC_API_KEY }, json = {
                "query":"mutation PublishData($name: String!, $data: AWSJSON!) { publish(name: $name, data: $data) { name data } }",
                "variables": {
                    "name": self.connectionId,
                    "data": response_body,
                }
            })
            self.api_res = api_res
            return
```


添加环境变量，APPSYNC_API_KEY, APPSYNC_ENDPOINT在以上AppSync中Settings可以获得。注意APPSYNC_ENDPOINT为GranphQL endpoint
[Image: image.png]修改完成后，点击Deploy发布。
[Image: image.png]
可选：发布一个新版本：

[Image: image.png]

[Image: image.png]修改别名prod为最新发布的版本
[Image: image.png][Image: image.png]



## **3. 配置 API Gateway**

### **3.1 为 API Gateway 创建 VPC Endpoint**

在 VPC 控制台，选择 Endpoints -> Create endpoint，创建步骤如下
为 endpoint 取名，Service category请选择**AWS services**，Services请选择**com.amazonaws.your-region.execute-api**
[Image: Image.jpg]
VPC 选择 smart search 方案所在的 VPC，子网根据实际情况选择，此处选择了私有子网，和安全组，Policy 可保持默认，检查无误后点击 Create 创建
[Image: Image.jpg][Image: Image.jpg]

### **3.2 在 API Gateway 创建 private_search REST API资源**

API Gateway服务中现有的smartsearch-api中创建新的资源Resource
[Image: image.png]
然后创建一个方法：
[Image: image.png]选择POST方法，集成类型选择Lambda function,开启Lambda Proxy integration，并且选择之前创建的private_search lambda，其他选项保持默认，然后创建方法。
[Image: image.png]
开启CORS
[Image: image.png]选中相关选项，如下图
[Image: image.png]
[Image: image.png]
[Image: image.png]
[Image: image.png]

最后Deploy API

[Image: Image.jpg]
[Image: Image.jpg]

可根据需求配置Resource Policy，配置完成后需要重新Deploy，例如，只允许本VPC内的资源访问此API，可以配置

```
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Deny",
            "Principal": "*",
            "Action": "execute-api:Invoke",
            "Resource": "execute-api:/*",
            "Condition": {
                "StringNotEquals": {
                    "awsSourceVpc": "您的vpcID"
                }
            }
        },
        {
            "Effect": "Allow",
            "Principal": "*",
            "Action": "execute-api:Invoke",
            "Resource": "execute-api:/*"
        }
    ]
}
```



## 4. 安全保护

可以采用WAF对API Gateway REST API和AppSync API进行保护。例如仅仅允许特定内网网段IP才可以访问：
进入WAF服务，创建一个IP set：
[Image: image.png]
进入WAF服务，创建一个WEB ACL，并且关联aws 资源：API Gateway的rest api smartsearch-api和Appsync api
[Image: image.png]下一步，增加my own rules，选择IP set
[Image: image.png]默认web ACL action 选择Block
[Image: image.png]其他选项都选择默认，最后完成创建这个Web ACL。


## 5. 前端测试

在 smart search 方案所在的 VPC 的私有子网创建一台 EC2 进行测试。
本测试选择 Amazon Linux 2 AMI，需要手动安装好 npm 和[wscat](https://docs.aws.amazon.com/appsync/latest/devguide/using-private-apis.html)（WebSocket 客户端命令行工具），参考指令：

```
sudo su
wget -nv https://d3rnber7ry90et.cloudfront.net/linux-x86_64/node-v18.17.1.tar.gz

mkdir /usr/local/lib/node
tar -xf node-v18.17.1.tar.gz
mv node-v18.17.1 /usr/local/lib/node/nodejs

echo "export NVM_DIR=''" >> /home/ec2-user/.bashrc
echo "export NODEJS_HOME=/usr/local/lib/node/nodejs" >> /home/ec2-user/.bashrc
echo "export PATH=\$NODEJS_HOME/bin:\$PATH" >> /home/ec2-user/.bashrc

. /home/ec2-user/.bashrc

node -e "console.log('Running Node.js ' + process.version)"

npm install -g wscat
```


_在terminal 1中_
首先向 AppSync发送握手请求：

请替换**host**和**x-api-key**，可在 AppSync 控制台查看相应参数，然后执行

`header=`echo '`**`{"host":"x3mkx4aoyzdfbonkyyygcvs2tu.appsync-api.us-east-1.amazonaws.com","x-api-key":"da2-xxxxxxxxxxxxxxxx"}`**`' | base64 -w0``

请替换**wss://....** 为 AppSync 的 Real-time endpoint，然后执行

`wscat -p 13 -s graphql-ws -c "`**`wss://x3xxxxxxxxxxxxxxxxu.appsync-realtime-api.us-east-1.amazonaws.com/graphql`**`?header=$header&payload=e30="`

输入下列指令初始化连接

`{"type": "connection_init"}`

得到响应后，请替换**host**和**x-api-key**，输入下列指令，发送订阅请求。

`{"type":"start","id":"1725180832603","payload":{"data":"{\"query\":\"subscription SubscribeToData($name: String!) { subscribe(name: $name) { name data } }\",\"variables\":{\"name\":\"private-1725180832603\"}}","extensions":{"authorization":`**`{"x-api-key":"da2-xxxxxxxxxxxxxxxx","host":"x3xxxxxxxxxxxxxxxxu.appsync-api.us-east-1.amazonaws.com"}`**`}}}`



_另起一个terminal 2，然后执行下列查询_

请替换 POST 后的 https 链接为 private_search 对应的API链接，其他请求参数可按需调整，执行下列查询

`curl -X POST https://wxxxxxxxxx0.execute-api.cn-northwest-1.amazonaws.com.cn/prod/private_search -H 'connectionId:private-1725180832603' -d '{"action":"search","configs":{"name":"","searchEngine":"opensearch","llmData":{"strategyName":"chatglm","type":"sagemaker_endpoint","embeddingEndpoint":"bge-m3-2024-08-16-03-31-21-276-endpoint","modelType":"non_llama2","recordId":"chatglm-2024-08-16-02-41-26-621-endpoint-27940","sagemakerEndpoint":"chatglm-2024-08-16-02-41-26-621-endpoint","streaming":true},"role":"","language":"chinese","taskDefinition":"","outputFormat":"","isCheckedGenerateReport":false,"isCheckedContext":false,"isCheckedKnowledgeBase":true,"indexName":"smart_search_qa_test","topK":"2","searchMethod":"vector","txtDocsNum":2,"vecDocsScoreThresholds":0,"txtDocsScoreThresholds":0,"isCheckedScoreQA":true,"isCheckedScoreQD":true,"isCheckedScoreAD":true,"contextRounds":0,"isCheckedEditPrompt":true,"prompt":"<任务定义>\\n 1. 请回答问题。\\n AI:\\n ","tokenContentCheck":"","responseIfNoDocsFound":"Cannot find the answer","sessionId":"1724150750236-70193"},"query":"Amazon EMR如何配置集群终止方式?"}'`



此查询会发送给 private_search REST API，后端 private_search 函数会把请求转发给 langchain_processor_qa 函数，此函数调用知识库和大模型对问题进行检索增强生成，然后将回答经由 AppSync GraphQL Endpoint -> AppSync Real-time Endpoint 发布至 websocket 客户端（terminal 1）。AppySync WebSocket 具体协议可参考[文档](https://docs.aws.amazon.com/zh_cn/appsync/latest/devguide/real-time-websocket-client.html)。

在terminal 1中可以看到回复
[Image: Image.jpg]
前端可以参考https://github.com/DiscreteTom/guidance-for-custom-search-of-an-enterprise-knowledge-base-on-aws/blob/private-appsync/ui-search/src/components/Session/SessionInput.jsx 

