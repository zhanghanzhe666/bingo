// Cloudflare Worker 主文件

// 常量定义
const BingConversationStyle = {
  Creative: 'Creative',
  Balanced: 'Balanced',
  Precise: 'Precise'
};

const ChatMessageType = {
  CHAT: 'Chat',
  IMAGE: 'Image'
};

const ErrorCode = {
  CONVERSATION_LIMIT: 'CONVERSATION_LIMIT',
  BING_UNAUTHORIZED: 'BING_UNAUTHORIZED',
  BING_FORBIDDEN: 'BING_FORBIDDEN',
  BING_CAPTCHA: 'BING_CAPTCHA',
  BING_THROTTLE_LIMIT: 'BING_THROTTLE_LIMIT',
  BING_UNKNOWN: 'BING_UNKNOWN',
  BING_IMAGE_UNAUTHORIZED: 'BING_IMAGE_UNAUTHORIZED',
};

// 工具函数
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function nanoid() {
  return Math.random().toString(36).substr(2, 10);
}

function formatDate(date) {
  return new Date(date).toISOString();
}

function messageToContext(messages, limit = 32000) {
  const messagesClone = [...messages];
  let cache = [];
  let curLen = 0;
  while (messagesClone.length) {
    const message = messagesClone.pop();
    const current = `[${message.role}](#message)\n${message.content?.trim()}\n`;
    if (curLen + current.length >= limit) break;
    cache.unshift(current);
    curLen += current.length + 1;
  }
  return cache.join('\n');
}

function md5(input) {
  return Array.from(input).reduce((hash, char) => {
    return ((hash << 5) - hash) + char.charCodeAt(0);
  }, 0).toString(16);
}

// BingWebBot 类
class BingWebBot {
  constructor({ endpoint, ua }) {
    this.endpoint = endpoint;
    this.ua = ua;
    this.cookie = null;
    this.conversationContext = null;
  }

  async getInitialCookie() {
    const headers = {
      'Accept-Encoding': 'gzip, deflate, br',
      'User-Agent': this.ua,
    };

    const response = await fetch(`${this.endpoint}/`, { headers });
    
    if (response.status !== 200) {
      throw new Error('Failed to get initial cookie');
    }

    const cookies = response.headers.get('set-cookie');
    if (!cookies) {
      throw new Error('No cookies received');
    }

    // 解析并存储需要的 cookie
    this.cookie = cookies.split(', ').filter(cookie => 
      cookie.startsWith('_U=') || 
      cookie.startsWith('MUID=') ||
      cookie.startsWith('MUIDB=')
    ).join('; ');

    return this.cookie;
  }

  async ensureCookie() {
    if (!this.cookie) {
      await this.getInitialCookie();
    }
  }

  async createConversation() {
    await this.ensureCookie();

    const headers = {
      'Accept-Encoding': 'gzip, deflate, br',
      'User-Agent': this.ua,
      'x-ms-useragent': 'azsdk-js-api-client-factory/1.0.0-beta.1 core-rest-pipeline/1.12.0 OS/Win32',
      'Cookie': this.cookie,
    };

    const response = await fetch(`${this.endpoint}/turing/conversation/create`, { headers });
    
    if (response.status !== 200) {
      throw new Error('Failed to create conversation');
    }

    // 更新 cookie
    const newCookies = response.headers.get('set-cookie');
    if (newCookies) {
      this.cookie = newCookies.split(', ').filter(cookie => 
        cookie.startsWith('_U=') || 
        cookie.startsWith('MUID=') ||
        cookie.startsWith('MUIDB=')
      ).join('; ');
    }

    const responseData = await response.json();
    if (!responseData.conversationId) {
      throw new Error('Invalid conversation response');
    }

    this.conversationContext = {
      conversationId: responseData.conversationId,
      clientId: responseData.clientId,
      conversationSignature: responseData.conversationSignature,
      invocationId: 0,
    };
  }

  async sendMessage({ prompt, context, options, signal, onEvent }) {
    await this.ensureCookie();

    if (!this.conversationContext) {
      await this.createConversation();
    }

    const headers = {
      'Accept-Encoding': 'gzip, deflate, br',
      'User-Agent': this.ua,
      'x-ms-useragent': 'azsdk-js-api-client-factory/1.0.0-beta.1 core-rest-pipeline/1.12.0 OS/Win32',
      'Cookie': this.cookie,
    };

    const requestId = nanoid();
    const timestamp = new Date().toISOString();

    const requestMessage = {
      arguments: [
        {
          source: 'cib',
          optionsSets: [
            'nlu_direct_response_filter',
            'deepleo',
            'enable_debug_commands',
            'disable_emoji_spoken_text',
            'responsible_ai_policy_235',
            'enablemm',
            'dv3sugg',
          ],
          allowedMessageTypes: ['Chat', 'InternalSearchQuery'],
          sliceIds: [],
          traceId: md5(requestId),
          isStartOfSession: this.conversationContext.invocationId === 0,
          message: {
            author: 'user',
            inputMethod: 'Keyboard',
            text: prompt,
            messageType: 'Chat',
          },
          conversationSignature: this.conversationContext.conversationSignature,
          participant: { id: this.conversationContext.clientId },
          conversationId: this.conversationContext.conversationId,
        },
      ],
      invocationId: String(this.conversationContext.invocationId),
      target: 'chat',
      type: 4,
    };

    if (context) {
      requestMessage.arguments[0].previousMessages = [
        {
          author: 'user',
          description: context,
          contextType: 'WebPage',
          messageType: 'Context',
          messageId: 'discover-web--page-ping-mriduna-----',
        },
      ];
    }

    const ws = new WebSocket('wss://sydney.bing.com/sydney/ChatHub');
    
    ws.onopen = () => {
      ws.send(JSON.stringify({ protocol: 'json', version: 1 }));
      ws.send(JSON.stringify({ type: 6 }));
      ws.send(JSON.stringify(requestMessage));
    };

    let receivedMessageText = '';
    let messageEnded = false;

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 1) {
        const messages = data.arguments[0].messages;
        if (messages) {
          const message = messages[0];
          if (message.messageType === 'InternalSearchQuery') {
            onEvent({ type: 'INTERNAL_SEARCH_QUERY', data: message });
          } else if (message.messageType === 'InternalSearchResult') {
            onEvent({ type: 'INTERNAL_SEARCH_RESULT', data: message });
          } else if (message.messageType === ChatMessageType.CHAT) {
            receivedMessageText = message.text;
            onEvent({ type: 'UPDATE_ANSWER', data: { text: receivedMessageText } });

            if (message.suggestedResponses) {
              onEvent({
                type: 'SUGGESTED_RESPONSES',
                data: message.suggestedResponses.map(r => r.text),
              });
            }
          }
        }

        if (data.arguments[0].throttling) {
          onEvent({ type: 'THROTTLING', data: data.arguments[0].throttling });
        }
      } else if (data.type === 2) {
        messageEnded = true;
        ws.close();
      }
    };

    while (!messageEnded) {
      await sleep(100);
      if (signal?.aborted) {
        ws.close();
        throw new Error('Aborted');
      }
    }

    return receivedMessageText;
  }

  async createImage(prompt) {
    await this.ensureCookie();

    const headers = {
      'Accept-Encoding': 'gzip, deflate, br',
      'User-Agent': this.ua,
      'x-ms-useragent': 'azsdk-js-api-client-factory/1.0.0-beta.1 core-rest-pipeline/1.12.0 OS/Win32',
      'Cookie': this.cookie,
    };

    const response = await fetch(`${this.endpoint}/images/create?q=${encodeURIComponent(prompt)}`, { headers });
    
    // 更新 cookie
    const newCookies = response.headers.get('set-cookie');
    if (newCookies) {
      this.cookie = newCookies.split(', ').filter(cookie => 
        cookie.startsWith('_U=') || 
        cookie.startsWith('MUID=') ||
        cookie.startsWith('MUIDB=')
      ).join('; ');
    }

    if (response.status !== 200) {
      throw new Error('Failed to create image');
    }

    const responseData = await response.json();
    return responseData.imageUrl;
  }
}

// OpenAI API 模拟
function parseOpenAIMessage(request) {
  const messages = request.messages.slice(0);
  const prompt = messages.pop()?.content;
  const context = messageToContext(messages);
  return {
    prompt,
    context,
    stream: request.stream,
    model: request.model,
  };
}

function responseOpenAIMessage(content) {
  const message = {
    role: 'assistant',
    content,
  };
  return {
    choices: [{
      delta: message,
      message,
    }],
  };
}

// Cloudflare Worker 主函数
export default {
  async fetch(request, env) {
    const headers = new Headers({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    if (request.method === 'GET') {
      return new Response('Bing Chat API is running', { headers });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers });
    }

    // 授权验证
    const authHeader = request.headers.get('Authorization');
    if (env.API_KEY && (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.slice(7) !== env.API_KEY)) {
      return new Response('Unauthorized', { status: 401, headers });
    }

    try {
      const requestBody = await request.json();
      const { prompt, context, stream, model } = parseOpenAIMessage(requestBody);

      assert(prompt, 'Prompt is required');

      const bingWebBot = new BingWebBot({
        endpoint: env.BING_ENDPOINT || 'https://www.bing.com',
        ua: env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36 Edg/113.0.1774.50',
      });

      let responseText = '';
      const streamResponse = new TransformStream();
      const writer = streamResponse.writable.getWriter();

      const sendMessage = async () => {
        await bingWebBot.sendMessage({
          prompt,
          context,
          options: {
            bingConversationStyle: BingConversationStyle.Creative,
          },
          onEvent: async (event) => {
            if (event.type === 'UPDATE_ANSWER') {
              responseText = event.data.text;
              if (stream) {
                const chunk = JSON.stringify(responseOpenAIMessage(responseText)) + '\n';
                await writer.write(new TextEncoder().encode(chunk));
              }
            }
          },
        });
      };

      if (stream) {
        headers.set('Content-Type', 'text/event-stream');
        const response = new Response(streamResponse.readable, { headers });
        sendMessage().finally(() => writer.close());
        return response;
      } else {
        await sendMessage();
        headers.set('Content-Type', 'application/json');
        return new Response(JSON.stringify(responseOpenAIMessage(responseText)), { headers });
      }
    } catch (error) {
      console.error('Error:', error);
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    }
  },
};
