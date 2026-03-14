import { spawn } from 'child_process';
import { Readable, Writable } from 'stream';
import { stdin as input, stdout as output } from 'process';

async function testListGraph() {
  // 启动MCP服务器
  const server = spawn('node', ['index.js'], {
    stdio: ['pipe', 'pipe', 'inherit']
  });

  let requestId = 1;

  function sendRequest(method, params) {
    const request = {
      jsonrpc: '2.0',
      id: requestId++,
      method,
      params
    };
    
    console.log('Sending request:', JSON.stringify(request, null, 2));
    server.stdin.write(JSON.stringify(request) + '\n');
  }

  // 收集输出
  let outputData = '';
  server.stdout.on('data', (data) => {
    outputData += data.toString();
    console.log('Received:', data.toString());
    
    // 尝试解析JSON行
    const lines = outputData.split('\n');
    for (const line of lines) {
      if (line.trim()) {
        try {
          const response = JSON.parse(line);
          console.log('Parsed response:', JSON.stringify(response, null, 2));
          
          if (response.result) {
            console.log('Result:', JSON.stringify(response.result, null, 2));
          } else if (response.error) {
            console.error('Error:', JSON.stringify(response.error, null, 2));
          }
        } catch (e) {
          // 不是完整的JSON，继续等待更多数据
        }
      }
    }
  });

  // 先创建一些实体
  setTimeout(() => {
    sendRequest('tools/call', {
      name: 'createEntity',
      arguments: {
        entities: [
          {
            name: 'TestEntity1',
            entityType: 'test',
            definition: 'A test entity',
            definitionSource: 'Test source',
            observations: ['Obs 1', 'Obs 2']
          },
          {
            name: 'TestEntity2',
            entityType: 'test',
            definition: 'Another test entity',
            // 故意不提供 definitionSource
            observations: ['Obs 3']
          }
        ]
      }
    });
  }, 1000);

  // 然后调用 listGraph
  setTimeout(() => {
    sendRequest('tools/call', {
      name: 'listGraph',
      arguments: {}
    });
  }, 2000);

  // 3秒后退出
  setTimeout(() => {
    console.log('Test complete');
    server.kill();
    process.exit(0);
  }, 3000);
}

testListGraph().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});