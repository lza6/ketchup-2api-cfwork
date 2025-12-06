/**
 * =================================================================================
 * 项目: ketchup-2api (Cloudflare Worker 单文件版)
 * 版本: 1.3.0 (代号: Stream Tunnel - 流式隧道)
 * 作者: 首席AI执行官 (Principal AI Executive Officer)
 * 协议: 奇美拉协议 · 综合版 (Project Chimera: Synthesis Edition)
 * 日期: 2025-12-06
 * 
 * [v1.3.0 关键修复]
 * 1. [协议适配] 完美修复 Cherry Studio 空白问题。当客户端请求 stream: true 时，
 *    强制返回 text/event-stream 格式，即使图片生成是同步的。
 * 2. [缓存隧道] 保持图片缓存机制，将巨大的 Base64 转换为短链接，确保客户端流畅渲染。
 * 3. [CORS增强] 图片文件路由增加严格的 CORS 头，防止画布跨域污染问题。
 * =================================================================================
 */

// --- [第一部分: 核心配置 (Configuration-as-Code)] ---
const CONFIG = {
  // 项目元数据
  PROJECT_NAME: "ketchup-2api",
  PROJECT_VERSION: "1.3.0",
  
  // 安全配置 (建议在 Cloudflare 环境变量中设置 API_MASTER_KEY)
  API_MASTER_KEY: "1", 
  
  // 上游服务配置
  UPSTREAM_API_URL: "https://ketchup-ai.com/api/image/generate",
  
  // 缓存配置
  CACHE_TTL: 3600, // 图片缓存1小时
  
  // 伪装指纹 (严格模拟 Chrome 142)
  HEADERS: {
    "authority": "ketchup-ai.com",
    "accept": "*/*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "content-type": "application/json",
    "origin": "https://ketchup-ai.com",
    "referer": "https://ketchup-ai.com/zh",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "priority": "u=1, i"
  },

  // 模型定义
  DEFAULT_MODEL: "ketchup-flux",
  MODELS: [
    "ketchup-flux",    
    "flux-schnell",    
    "dall-e-3"         
  ],

  // 尺寸映射
  SIZE_MAP: {
    "1024x1024": { w: 1024, h: 1024 },
    "1792x1024": { w: 1792, h: 1024 },
    "1024x1792": { w: 1024, h: 1792 },
    "1152x896":  { w: 1152, h: 896 },
    "896x1152":  { w: 896, h: 1152 },
    "1536x640":  { w: 1536, h: 640 },
    "640x1536":  { w: 640, h: 1536 },
    "1280x832":  { w: 1280, h: 832 },
    "832x1280":  { w: 832, h: 1280 }
  }
};

// --- [第二部分: Worker 入口与路由] ---
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // 1. CORS 预检 (所有路由都允许跨域)
    if (request.method === 'OPTIONS') return handleCorsPreflight();

    // 环境变量覆盖配置
    const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;
    request.ctx = { apiKey, origin: url.origin, ctx };

    // 2. 路由分发
    
    // [核心] 图片文件代理路由 (用于 Cherry Studio 加载图片)
    if (url.pathname.startsWith('/file/')) {
        return handleImageFetch(request);
    }

    // Web UI
    if (url.pathname === '/' || url.pathname === '/index.html') {
        return handleUI(request);
    }
    
    // API 接口
    if (url.pathname.startsWith('/v1/')) {
        return handleApi(request);
    }

    // 404
    return createErrorResponse(`路径未找到: ${url.pathname}`, 404, 'not_found');
  }
};

// --- [第三部分: 核心业务逻辑] ---

// 1. API 路由处理
async function handleApi(request) {
  if (!verifyAuth(request)) {
    return createErrorResponse('Unauthorized - 需要 Bearer Token', 401, 'unauthorized');
  }

  const url = new URL(request.url);
  const requestId = `req-${crypto.randomUUID()}`;

  if (url.pathname === '/v1/models') {
    return handleModelsRequest();
  }
  
  if (url.pathname === '/v1/chat/completions') {
    return handleChatCompletions(request, requestId);
  }

  if (url.pathname === '/v1/images/generations') {
    return handleImageGenerations(request, requestId);
  }

  return createErrorResponse('Method not supported', 404, 'not_found');
}

// 2. 鉴权逻辑
function verifyAuth(request) {
  const auth = request.headers.get('Authorization');
  const key = request.ctx.apiKey;
  if (key === "1") return true; 
  return auth === `Bearer ${key}`;
}

// 3. 模型列表
function handleModelsRequest() {
  const modelsData = CONFIG.MODELS.map(id => ({
    id: id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "ketchup-ai"
  }));

  return new Response(JSON.stringify({
    object: "list",
    data: modelsData
  }), { headers: corsHeaders({ "Content-Type": "application/json" }) });
}

// 4. 核心生成逻辑 (调用上游)
async function generateImage(prompt, sizeStr) {
  // 解析尺寸
  let width = 1024;
  let height = 1024;
  
  if (sizeStr && CONFIG.SIZE_MAP[sizeStr]) {
    width = CONFIG.SIZE_MAP[sizeStr].w;
    height = CONFIG.SIZE_MAP[sizeStr].h;
  } else if (sizeStr && sizeStr.includes('x')) {
    const parts = sizeStr.split('x');
    if (parts.length === 2) {
        width = parseInt(parts[0]) || 1024;
        height = parseInt(parts[1]) || 1024;
    }
  }

  const payload = {
    prompt: prompt,
    width: width,
    height: height
  };

  const response = await fetch(CONFIG.UPSTREAM_API_URL, {
    method: "POST",
    headers: CONFIG.HEADERS,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`上游服务错误 (${response.status}): ${text.substring(0, 200)}`);
  }

  const data = await response.json();
  
  if (data.code !== 0 || !data.data || !data.data.image) {
    throw new Error(`生成失败: ${data.message || JSON.stringify(data)}`);
  }

  return data.data.image; // 返回完整的 Data URI (data:image/jpeg;base64,...)
}

// 5. [核心] 同步缓存隧道逻辑
async function storeImageInCache(dataUri, request) {
    const cache = caches.default;
    const uuid = crypto.randomUUID();
    
    // 自动检测 MIME 类型
    let mimeType = "image/jpeg";
    let extension = "jpg";
    
    const match = dataUri.match(/^data:(image\/([a-zA-Z]+));base64,/);
    if (match) {
        mimeType = match[1];
        extension = match[2] === 'jpeg' ? 'jpg' : match[2];
    }

    const fileName = `${uuid}.${extension}`;
    const fileUrl = `${request.ctx.origin}/file/${fileName}`;
    
    // 解析 Base64
    const b64Data = dataUri.split(',')[1];
    const binaryStr = atob(b64Data);
    const len = binaryStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
    }

    // 构造响应对象
    const imageResponse = new Response(bytes, {
        headers: {
            "Content-Type": mimeType,
            "Content-Length": bytes.length.toString(),
            "Cache-Control": `public, max-age=${CONFIG.CACHE_TTL}, immutable`,
            "Access-Control-Allow-Origin": "*", // 允许跨域
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS"
        }
    });

    // 存入缓存 (使用 await 确保写入完成)
    const cacheKey = new Request(fileUrl, { method: "GET" });
    await cache.put(cacheKey, imageResponse.clone());

    return fileUrl;
}

// 6. 图片获取路由处理
async function handleImageFetch(request) {
    const cache = caches.default;
    const response = await cache.match(request.url);
    
    if (!response) {
        return new Response("Image expired or not found (Cache Miss)", { status: 404 });
    }
    
    // 重新构造响应以确保 CORS 头存在
    const newResponse = new Response(response.body, response);
    newResponse.headers.set("Access-Control-Allow-Origin", "*");
    return newResponse;
}

// 7. [关键修复] 处理 Chat 接口 (适配 Cherry Studio 流式)
async function handleChatCompletions(request, requestId) {
  try {
    const body = await request.json();
    const messages = body.messages || [];
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || !lastMsg.content) throw new Error("消息为空");

    const prompt = lastMsg.content;
    const model = body.model || CONFIG.DEFAULT_MODEL;
    const isStream = body.stream === true; // 检查是否请求流式
    
    // 尺寸解析
    let size = "1024x1024";
    if (prompt.includes("16:9")) size = "1792x1024";
    else if (prompt.includes("9:16")) size = "1024x1792";
    else if (prompt.includes("4:3")) size = "1152x896";
    else if (prompt.includes("3:4")) size = "896x1152";

    // 执行生成 (耗时操作)
    const dataUri = await generateImage(prompt, size);
    
    // 存入缓存，获取 URL
    const imageUrl = await storeImageInCache(dataUri, request);
    
    // 构造 Markdown 响应
    const content = `![Generated Image](${imageUrl})\n\n**Prompt:** ${prompt}\n**Size:** ${size}`;

    // [分支 A] 流式响应 (Cherry Studio 需要这个)
    if (isStream) {
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();

        // 异步推送数据
        (async () => {
            try {
                // 推送内容块
                const chunk = {
                    id: requestId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: model,
                    choices: [{ index: 0, delta: { content: content }, finish_reason: null }]
                };
                await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));

                // 推送结束块
                const endChunk = {
                    id: requestId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: model,
                    choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
                };
                await writer.write(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
                await writer.write(encoder.encode('data: [DONE]\n\n'));
            } catch (e) {
                // 错误处理
                const errChunk = {
                    id: requestId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: model,
                    choices: [{ index: 0, delta: { content: `\n\nError: ${e.message}` }, finish_reason: "stop" }]
                };
                await writer.write(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
            } finally {
                await writer.close();
            }
        })();

        return new Response(readable, {
            headers: corsHeaders({
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive"
            })
        });
    }

    // [分支 B] 非流式响应 (普通 API 调用)
    const response = {
      id: requestId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: content
        },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };

    return new Response(JSON.stringify(response), {
      headers: corsHeaders({ "Content-Type": "application/json" })
    });

  } catch (e) {
    return createErrorResponse(e.message, 500, 'internal_error');
  }
}

// 8. 处理 Image 接口
async function handleImageGenerations(request, requestId) {
  try {
    const body = await request.json();
    const prompt = body.prompt;
    const size = body.size || "1024x1024";
    
    const dataUri = await generateImage(prompt, size);
    const imageUrl = await storeImageInCache(dataUri, request);

    return new Response(JSON.stringify({
      created: Math.floor(Date.now() / 1000),
      data: [{ 
        url: imageUrl, 
        revised_prompt: prompt 
      }]
    }), {
      headers: corsHeaders({ "Content-Type": "application/json" })
    });

  } catch (e) {
    return createErrorResponse(e.message, 500, 'internal_error');
  }
}

// --- 辅助函数 ---

function createErrorResponse(msg, status, code) {
  return new Response(JSON.stringify({
    error: { message: msg, type: 'api_error', code: code }
  }), { 
    status: status, 
    headers: corsHeaders({ "Content-Type": "application/json" }) 
  });
}

function handleCorsPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400'
  };
}

// --- [第四部分: 开发者驾驶舱 UI (WebUI)] ---
function handleUI(request) {
  const origin = new URL(request.url).origin;
  const apiKey = request.ctx.apiKey;
  
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${CONFIG.PROJECT_NAME} - 开发者驾驶舱</title>
    <style>
      :root { --bg: #121212; --panel: #1E1E1E; --border: #333; --text: #E0E0E0; --primary: #FF4500; --accent: #FF6347; --code: #111; }
      body { font-family: 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); margin: 0; height: 100vh; display: flex; overflow: hidden; }
      
      /* 布局 */
      .sidebar { width: 360px; background: var(--panel); border-right: 1px solid var(--border); padding: 20px; display: flex; flex-direction: column; overflow-y: auto; flex-shrink: 0; }
      .main { flex: 1; display: flex; flex-direction: column; padding: 20px; position: relative; }
      
      /* 组件 */
      h1 { margin: 0 0 20px 0; font-size: 20px; color: var(--primary); display: flex; align-items: center; gap: 10px; }
      .badge { font-size: 10px; background: #333; padding: 2px 6px; border-radius: 4px; color: #888; }
      
      .box { background: #252525; padding: 15px; border-radius: 8px; border: 1px solid var(--border); margin-bottom: 15px; }
      .label { font-size: 12px; color: #888; margin-bottom: 8px; display: block; font-weight: 600; }
      .code-block { font-family: monospace; font-size: 12px; color: var(--accent); word-break: break-all; background: var(--code); padding: 10px; border-radius: 4px; cursor: pointer; border: 1px solid #333; }
      .code-block:hover { border-color: var(--primary); }
      
      input, select, textarea { width: 100%; background: #333; border: 1px solid #444; color: #fff; padding: 10px; border-radius: 4px; margin-bottom: 10px; box-sizing: border-box; font-family: inherit; }
      input:focus, textarea:focus { border-color: var(--primary); outline: none; }
      
      button { width: 100%; padding: 12px; background: var(--primary); border: none; border-radius: 4px; font-weight: bold; cursor: pointer; color: #fff; transition: 0.2s; }
      button:hover { opacity: 0.9; }
      button:disabled { background: #555; cursor: not-allowed; }
      
      /* 聊天窗口 */
      .chat-window { flex: 1; background: #000; border: 1px solid var(--border); border-radius: 8px; padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 20px; }
      .msg { max-width: 80%; padding: 15px; border-radius: 8px; line-height: 1.5; }
      .msg.user { align-self: flex-end; background: #333; color: #fff; border-bottom-right-radius: 2px; }
      .msg.ai { align-self: flex-start; background: #1a1a1a; border: 1px solid #333; width: 100%; max-width: 100%; border-bottom-left-radius: 2px; }
      .msg.ai img { max-width: 100%; border-radius: 4px; margin-top: 10px; display: block; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
      
      /* 日志面板 */
      .log-panel { height: 150px; background: var(--code); border-top: 1px solid var(--border); padding: 10px; font-family: monospace; font-size: 11px; color: #aaa; overflow-y: auto; margin-top: 20px; border-radius: 8px; }
      .log-entry { margin-bottom: 4px; border-bottom: 1px solid #222; padding-bottom: 2px; }
      .log-time { color: #666; margin-right: 5px; }
      .log-type { color: var(--primary); font-weight: bold; margin-right: 5px; }
      
      /* 状态指示器 */
      .status-bar { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #888; margin-bottom: 10px; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #4CAF50; box-shadow: 0 0 5px #4CAF50; }
    </style>
</head>
<body>
    <div class="sidebar">
        <h1>🍅 ${CONFIG.PROJECT_NAME} <span class="badge">v${CONFIG.PROJECT_VERSION}</span></h1>
        
        <div class="status-bar">
            <div class="dot"></div>
            <span>系统就绪 (流式隧道已激活)</span>
        </div>

        <div class="box">
            <span class="label">API 密钥 (点击复制)</span>
            <div class="code-block" onclick="copy('${apiKey}')">${apiKey}</div>
        </div>

        <div class="box">
            <span class="label">API 接口地址</span>
            <div class="code-block" onclick="copy('${origin}/v1/chat/completions')">${origin}/v1/chat/completions</div>
        </div>

        <div class="box">
            <span class="label">模型</span>
            <select id="model">
                ${CONFIG.MODELS.map(m => `<option value="${m}">${m}</option>`).join('')}
            </select>
            
            <span class="label">比例 (Aspect Ratio)</span>
            <select id="size">
                <option value="1024x1024">1:1 (方形)</option>
                <option value="1792x1024">16:9 (横屏)</option>
                <option value="1024x1792">9:16 (竖屏)</option>
                <option value="1152x896">4:3</option>
                <option value="896x1152">3:4</option>
                <option value="1536x640">21:9</option>
                <option value="640x1536">9:21</option>
            </select>

            <span class="label" style="margin-top:10px">提示词 (Prompt)</span>
            <textarea id="prompt" rows="4" placeholder="描述你想生成的图片... 例如: A futuristic city with flying cars, cyberpunk style"></textarea>
            
            <button id="btn-gen" onclick="generate()">🚀 开始生成</button>
        </div>
        
        <div style="font-size:11px; color:#666; text-align:center;">
            Powered by Ketchup AI & Cloudflare Workers
        </div>
    </div>

    <main class="main">
        <div class="chat-window" id="chat">
            <div style="color:#666; text-align:center; margin-top:100px;">
                <div style="font-size:40px; margin-bottom:20px;">🎨</div>
                <h3>Ketchup 绘图代理就绪</h3>
                <p>已启用流式隧道，完美适配 Cherry Studio。</p>
            </div>
        </div>
        <div class="log-panel" id="logs">
            <div class="log-entry"><span class="log-time">[System]</span> 初始化完成。</div>
        </div>
    </main>

    <script>
        const API_KEY = "${apiKey}";
        const ENDPOINT = "${origin}/v1/chat/completions";
        
        function copy(text) {
            navigator.clipboard.writeText(text);
            log('System', '已复制到剪贴板');
        }

        function log(type, msg) {
            const el = document.getElementById('logs');
            const div = document.createElement('div');
            div.className = 'log-entry';
            div.innerHTML = \`<span class="log-time">[\${new Date().toLocaleTimeString()}]</span> <span class="log-type">\${type}</span> \${msg}\`;
            el.appendChild(div);
            el.scrollTop = el.scrollHeight;
        }

        function appendMsg(role, html) {
            const div = document.createElement('div');
            div.className = \`msg \${role}\`;
            div.innerHTML = html;
            document.getElementById('chat').appendChild(div);
            div.scrollIntoView({ behavior: "smooth" });
            return div;
        }

        async function generate() {
            const prompt = document.getElementById('prompt').value.trim();
            if (!prompt) return alert('请输入提示词');

            const btn = document.getElementById('btn-gen');
            btn.disabled = true;
            btn.innerText = "生成中...";

            // 清空欢迎语
            if(document.querySelector('.chat-window').innerText.includes('代理就绪')) {
                document.getElementById('chat').innerHTML = '';
            }

            const size = document.getElementById('size').value;
            const model = document.getElementById('model').value;

            // 构造用户消息
            appendMsg('user', \`\${prompt} <br><span style="font-size:12px;color:#888;background:#222;padding:2px 6px;border-radius:4px;margin-top:5px;display:inline-block;">Size: \${size}</span>\`);
            
            const loadingMsg = appendMsg('ai', '⏳ 正在请求 Ketchup AI 生成图片...');
            
            log('Request', \`发送请求: \${prompt.substring(0, 20)}... (Size: \${size})\`);

            try {
                // Hack: 将尺寸作为隐藏指令传给后端
                let sizeKeyword = "";
                if (size === "1792x1024") sizeKeyword = " --ar 16:9";
                else if (size === "1024x1792") sizeKeyword = " --ar 9:16";
                
                const finalPrompt = prompt + sizeKeyword;

                const res = await fetch(ENDPOINT, {
                    method: 'POST',
                    headers: { 
                        'Authorization': 'Bearer ' + API_KEY, 
                        'Content-Type': 'application/json' 
                    },
                    body: JSON.stringify({
                        model: model,
                        messages: [{ role: 'user', content: finalPrompt }],
                        stream: true // Web UI 也使用流式
                    })
                });

                if (!res.ok) {
                    const errData = await res.json();
                    throw new Error(errData.error?.message || '生成失败');
                }

                // 处理流式响应
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let fullContent = "";

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    const chunk = decoder.decode(value, { stream: true });
                    const lines = chunk.split('\\n');
                    
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const dataStr = line.slice(6);
                            if (dataStr === '[DONE]') continue;
                            try {
                                const data = JSON.parse(dataStr);
                                const content = data.choices[0]?.delta?.content || "";
                                fullContent += content;
                            } catch (e) {}
                        }
                    }
                }
                
                // 解析 Markdown 图片链接
                const match = fullContent.match(/\\((https:.*?)\\)/);
                if (match) {
                    const imgUrl = match[1];
                    loadingMsg.innerHTML = \`
                        <div><strong>✨ 生成成功</strong></div>
                        <img src="\${imgUrl}" onclick="window.open(this.src)">
                        <div style="margin-top:10px; display:flex; gap:10px;">
                            <a href="\${imgUrl}" download="ketchup-\${Date.now()}.png" style="color:var(--primary);text-decoration:none;border:1px solid #444;padding:5px 10px;border-radius:4px;font-size:12px;">⬇️ 下载图片</a>
                        </div>
                    \`;
                    log('Success', '图片生成完成，URL: ' + imgUrl);
                } else {
                    loadingMsg.innerText = "生成完成，但无法解析图片数据。";
                    log('Warning', '无法解析图片数据');
                }

            } catch (e) {
                loadingMsg.innerHTML = \`<span style="color:#CF6679">❌ 错误: \${e.message}</span>\`;
                log('Error', e.message);
            } finally {
                btn.disabled = false;
                btn.innerText = "🚀 开始生成";
            }
        }
    </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Encoding': 'br'
    },
  });
}
