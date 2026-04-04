/**
 * Git Sync 功能测试
 * 使用 gitSyncStatus 工具测试有无 git 环境的反应
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 测试场景
const scenarios = [
    {
        name: '场景1: GITAUTOCOMMIT 未设置',
        env: {},
        expectedGitSync: false,
        description: 'gitSyncEnabled=false, 返回 "requires GITAUTOCOMMIT=true to activate"'
    },
    {
        name: '场景2: GITAUTOCOMMIT=false',
        env: { GITAUTOCOMMIT: 'false' },
        expectedGitSync: false,
        description: 'gitSyncEnabled=false, 返回 "requires GITAUTOCOMMIT=true to activate"'
    },
    {
        name: '场景3: GITAUTOCOMMIT=true',
        env: { GITAUTOCOMMIT: 'true' },
        expectedGitSync: true,
        description: 'gitSyncEnabled=true, git已安装则正常工作'
    },
    {
        name: '场景4: GITAUTOCOMMIT=1',
        env: { GITAUTOCOMMIT: '1' },
        expectedGitSync: true,
        description: 'gitSyncEnabled=true (1 等同于 true)'
    },
    {
        name: '场景5: GITAUTOCOMMIT=yes',
        env: { GITAUTOCOMMIT: 'yes' },
        expectedGitSync: true,
        description: 'gitSyncEnabled=true (yes 等同于 true)'
    },
    {
        name: '场景6: GITAUTOCOMMIT=YES (大写)',
        env: { GITAUTOCOMMIT: 'YES' },
        expectedGitSync: true,
        description: 'gitSyncEnabled=true (不区分大小写)'
    }
];

// MCP 请求模拟 - 使用 tools/call
function createToolCallRequest(id, toolName, args = {}) {
    return {
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: toolName, arguments: args }
    };
}

// 启动 MCP 服务器并返回进程
function startServer(env = {}) {
    const serverEnv = { 
        ...process.env, 
        ...env
    };
    
    return spawn('node', ['index.js'], {
        cwd: __dirname,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: serverEnv
    });
}

// 发送请求并获取响应
async function sendRequest(server, request, timeout = 5000) {
    return new Promise((resolve, reject) => {
        let data = '';
        let stderrData = '';

        const timer = setTimeout(() => {
            reject(new Error(`Request timeout after ${timeout}ms. Data: ${data}`));
        }, timeout);

        server.stdout.on('data', (chunk) => {
            data += chunk.toString();
            // console.log('   stdout:', chunk.toString().substring(0, 100));
        });

        server.stderr.on('data', (chunk) => {
            stderrData += chunk.toString();
        });

        server.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });

        server.stdin.write(JSON.stringify(request) + '\n');

        // 等待响应 - 跳过非JSON行
        const checkInterval = setInterval(() => {
            const lines = data.split('\n');
            for (const line of lines) {
                if (!line.trim()) continue;
                // 跳过非JSON行 (如 "MCP error" 等)
                if (!line.trim().startsWith('{')) {
                    // console.log(`   跳过非JSON行: ${line.trim().substring(0, 50)}`);
                    continue;
                }
                try {
                    const response = JSON.parse(line);
                    if (response.id === request.id) {
                        clearInterval(checkInterval);
                        clearTimeout(timer);
                        resolve({ response, stderr: stderrData });
                        return;
                    }
                } catch (e) {
                    // 继续等待
                }
            }
            // 检查是否收到错误信息
            if (data.includes('MCP error')) {
                clearInterval(checkInterval);
                clearTimeout(timer);
                reject(new Error(`MCP error detected in output: ${data.substring(0, 200)}`));
            }
        }, 100);
    });
}

// 测试 git 安装状态
async function testGitInstallation() {
    console.log('\n============================================================');
    console.log('测试 Git 安装检测');
    console.log('============================================================\n');

    const { execSync } = await import('child_process');
    try {
        const version = execSync('git --version', { encoding: 'utf8' }).trim();
        console.log(`✅ Git 已安装: ${version}`);
        return true;
    } catch {
        console.log('❌ Git 未安装');
        return false;
    }
}

// 运行单个场景测试
async function runScenario(scenario) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(scenario.name);
    console.log(`${'='.repeat(60)}`);
    console.log(`📋 ${scenario.description}`);
    console.log(`🔧 环境变量: GITAUTOCOMMIT=${scenario.env.GITAUTOCOMMIT || '(未设置)'}`);

    const server = startServer(scenario.env);
    
    // 等待服务器启动
    await new Promise(resolve => setTimeout(resolve, 800));

    const request = createToolCallRequest(1, 'gitSyncStatus');
    
    try {
        const { response, stderr } = await sendRequest(server, request);
        
        if (response.result && response.result.content) {
            const result = JSON.parse(response.result.content[0].text);
            console.log('\n📊 返回结果:');
            console.log(`   gitSyncEnabled: ${result.gitSyncEnabled}`);
            console.log(`   gitInstalled: ${result.gitInstalled}`);
            
            if (result.warnings && result.warnings.length > 0) {
                console.log('   warnings:');
                result.warnings.forEach(w => console.log(`     - ${w}`));
            }

            // 验证
            if (result.gitSyncEnabled === scenario.expectedGitSync) {
                console.log('   ✅ gitSyncEnabled 符合预期');
            } else {
                console.log(`   ❌ gitSyncEnabled 不符合预期 (期望: ${scenario.expectedGitSync}, 实际: ${result.gitSyncEnabled})`);
            }
        } else if (response.error) {
            console.log(`❌ MCP 错误: ${JSON.stringify(response.error)}`);
        } else {
            console.log(`❓ 未知响应: ${JSON.stringify(response)}`);
        }
    } catch (err) {
        console.log(`❌ 测试失败: ${err.message}`);
    } finally {
        server.kill();
        await new Promise(resolve => setTimeout(resolve, 200));
    }
}

// 主测试函数
async function main() {
    console.log('🧪 Git Sync 功能模拟测试 (使用 gitSyncStatus 工具)');
    console.log('='.repeat(60));

    // 先测试 git 安装状态
    await testGitInstallation();

    // 运行各个场景测试
    for (const scenario of scenarios) {
        await runScenario(scenario);
    }

    console.log('\n============================================================');
    console.log('✅ 所有测试完成');
    console.log('============================================================');
}

main().catch(console.error);
