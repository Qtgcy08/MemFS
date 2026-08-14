/**
 * MCP 客户端模块
 * 用于模拟真实 MCP 调用，发现实际使用时的问题
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * MCP 客户端类
 * 启动服务器并模拟 MCP 协议调用
 */
export class MCPClient {
    /**
     * @param {string} serverPath - 服务器入口文件路径
     * @param {object} env - 环境变量
     * @param {string[]} args - 附加 CLI 参数
     */
    constructor(serverPath = 'index.js', env = {}, args = []) {
        this.serverPath = serverPath;
        this.serverDir = path.dirname(path.resolve(serverPath));
        this.env = env;
        this.args = args;
        this.server = null;
        this.requestId = 1;
        this.pendingRequests = new Map();
        this.started = false;
    }

    /**
     * 启动 MCP 服务器
     */
    async start() {
        if (this.server) {
            return;
        }

        const serverEnv = {
            ...process.env,
            ...this.env
        };

        this.server = spawn('node', [this.serverPath, ...this.args], {
            cwd: this.serverDir,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: serverEnv
        });

        // JSON-RPC 响应解析器：立即注册，不丢失 stdout 数据
        let responseBuffer = '';
        const onStdout = (chunk) => {
            responseBuffer += chunk.toString();
            const lines = responseBuffer.split('\n');
            responseBuffer = '';

            for (const line of lines) {
                if (!line.trim() || !line.trim().startsWith('{')) {
                    continue;
                }
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.id && this.pendingRequests.has(parsed.id)) {
                        const { resolve, reject } = this.pendingRequests.get(parsed.id);
                        this.pendingRequests.delete(parsed.id);
                        resolve(parsed);
                    }
                } catch {
                    responseBuffer += '\n' + line;
                }
            }
        };
        this.server.stdout.on('data', onStdout);

        // 等待服务器启动（检测 stderr 中的启动消息）
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Server start timeout'));
            }, 5000);

            this.server.stderr.on('data', (data) => {
                const output = data.toString();
                if (output.includes('running on stdio') || output.includes('Knowledge Graph')) {
                    clearTimeout(timeout);
                    this.started = true;
                    resolve();
                }
                // 显示非错误信息
                if (!output.includes('Error') && !output.includes('error') && !output.includes(' at ')) {
                    console.error('[MCP Server]:', output);
                }
            });

            this.server.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });

            // 安全后备：1 秒后如果还没检测到启动消息也继续
            setTimeout(() => {
                if (!this.started) {
                    clearTimeout(timeout);
                    this.started = true;
                    resolve();
                }
            }, 1000);
        });
    }

    /**
     * 停止 MCP 服务器
     */
    async stop() {
        if (this.server) {
            this.server.kill();
            this.server = null;
            this.started = false;
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }

    /**
     * 发送 MCP 请求
     * @param {string} method - 方法名
     * @param {object} params - 参数
     * @returns {Promise<object>} 响应结果
     */
    async request(method, params = {}) {
        if (!this.started) {
            await this.start();
        }

        const id = this.requestId++;
        const request = {
            jsonrpc: '2.0',
            id,
            method,
            params
        };

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`Request timeout: ${method}`));
            }, 10000);

            this.pendingRequests.set(id, {
                resolve: (response) => {
                    clearTimeout(timeout);
                    if (response.error) {
                        reject(new Error(`MCP Error: ${JSON.stringify(response.error)}`));
                    } else {
                        resolve(response.result);
                    }
                },
                reject: (err) => {
                    clearTimeout(timeout);
                    reject(err);
                }
            });

            this.server.stdin.write(JSON.stringify(request) + '\n');
        });
    }

    /**
     * 调用工具
     * @param {string} toolName - 工具名称
     * @param {object} args - 工具参数
     * @returns {Promise<object>} 工具执行结果
     */
    async callTool(toolName, args = {}) {
        const result = await this.request('tools/call', {
            name: toolName,
            arguments: args
        });
        return result;
    }

    /**
     * 获取工具列表
     * @returns {Promise<array>} 工具列表
     */
    async listTools() {
        const result = await this.request('tools/list');
        return result.tools || [];
    }

    /**
     * 初始化测试数据
     * @param {array} entities - 实体数组
     * @param {array} relations - 关系数组
     */
    async setupTestData(entities, relations) {
        // 创建实体
        if (entities && entities.length > 0) {
            await this.callTool('createEntity', { entities });
        }

        // 创建关系
        if (relations && relations.length > 0) {
            await this.callTool('createRelation', { relations });
        }
    }

    /**
     * 清理测试数据
     */
    async cleanupTestData() {
        // 列出所有实体并删除
        try {
            const nodes = await this.callTool('listNode');
            if (nodes && nodes.length > 0) {
                const names = nodes.map(n => n.name);
                await this.callTool('deleteEntity', { entityNames: names });
            }
        } catch (err) {
            console.error('Cleanup error:', err.message);
        }
    }
}

/**
 * 创建 MCP 客户端的便捷函数
 * @param {object} env - 环境变量
 * @param {string[]} args - 附加 CLI 参数
 * @returns {MCPClient}
 */
export function createMCPClient(env = {}, args = []) {
    return new MCPClient('index.js', env, args);
}

export default { MCPClient, createMCPClient };
