// Background Script for Claude API integration

interface CorrectionIssue {
  type: 'typo' | 'nativeness';
  original: string;
  corrected: string;
  reason: string;
  severity: number;
}

interface CorrectionResult {
  correctedText: string;
  issues: CorrectionIssue[];
  score: number;
  needsCorrection: boolean;
}

interface ChromeRuntimeMessage {
  action: string;
  text?: string;
}

interface ChromeRuntimeResponse {
  success: boolean;
  data?: CorrectionResult;
  error?: string;
}

interface ClaudeAPIRequest {
  model: string;
  max_tokens: number;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
  tool_choice: {
    type: 'tool';
    name: string;
  };
  tools: Array<{
    name: string;
    description: string;
    input_schema: object;
  }>;
}

interface ClaudeAPIResponse {
  content: Array<{
    type: 'text' | 'tool_use';
    text?: string;
    name?: string;
    input?: CorrectionResult;
  }>;
}

class ClaudeAPIService {
  private apiUrl: string;

  constructor() {
    this.apiUrl = 'https://api.anthropic.com/v1/messages';
    this.setupMessageListener();
  }

  setupMessageListener(): void {
    chrome.runtime.onMessage.addListener((
      request: ChromeRuntimeMessage, 
      sender: chrome.runtime.MessageSender, 
      sendResponse: (response: ChromeRuntimeResponse) => void
    ) => {
      if (request.action === 'correctText' && request.text) {
        this.correctText(request.text)
          .then(response => sendResponse({ success: true, data: response }))
          .catch(error => sendResponse({ success: false, error: error.message }));
        return true; // 非同期レスポンス用
      }
    });
  }

  async correctText(text: string): Promise<CorrectionResult> {
    try {
      // APIキーを取得
      const result = await chrome.storage.local.get(['claudeApiKey']);
      const apiKey = result.claudeApiKey as string;

      if (!apiKey) {
        throw new Error('APIキーが設定されていません。拡張機能のオプションページで設定してください。');
      }

      const prompt = this.createCorrectionPrompt(text.trim());

      const requestBody: ClaudeAPIRequest = {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        tool_choice: {
          type: 'tool',
          name: 'correction_response'
        },
        tools: [
          {
            name: 'correction_response',
            description: 'テキスト校正の結果を構造化された形式で返す',
            input_schema: {
              type: 'object',
              properties: {
                correctedText: {
                  type: 'string',
                  description: '校正後のテキスト'
                },
                issues: {
                  type: 'array',
                  description: '検出された問題のリスト',
                  items: {
                    type: 'object',
                    properties: {
                      type: {
                        type: 'string',
                        enum: ['typo', 'nativeness'],
                        description: '問題の種類'
                      },
                      original: {
                        type: 'string',
                        description: '修正前の文字列'
                      },
                      corrected: {
                        type: 'string',
                        description: '修正後の文字列'
                      },
                      reason: {
                        type: 'string',
                        description: '修正理由の説明(ここだけは日本語で、なんj民っぽく)'
                      },
                      severity: {
                        type: 'number',
                        minimum: 0.0,
                        maximum: 1.0,
                        description: 'ネイティブから見た不自然度 (0.0-1.0）'
                      }
                    },
                    required: ['type', 'original', 'corrected', 'reason', 'severity']
                  }
                },
                score: {
                  type: 'number',
                  minimum: 0.0,
                  maximum: 1.0,
                  description: '校正が必要な度合いのスコア（0.0-1.0）'
                },
                needsCorrection: {
                  type: 'boolean',
                  description: '校正が必要かどうか'
                }
              },
              required: ['correctedText', 'issues', 'score', 'needsCorrection']
            }
          }
        ]
      };

      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify(requestBody)
      });

      console.log(response);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`API Error: ${response.status} - ${errorData.error?.message || 'Unknown error'}`);
      }

      const data: ClaudeAPIResponse = await response.json();
      return this.parseStructuredResponse(data);

    } catch (error) {
      console.error('Claude API Error:', error);
      throw error;
    }
  }

  createCorrectionPrompt(text: string): string {
    return `以下のSlackメッセージを校正してください。

原文: "${text}"

校正の観点：
1. 誤字脱字の修正 (type: "typo")
2. ネイティブがする言い回しかどうか。(type: "nativeness")
3. ネイティブスピーカーとして自然に感じる限り、指摘された部分以外は元の文章のもののまま文章を出力する(OK->Okay, I am -> I'm などどっちでもいい場合は勝手に変えない)。

correction_responseツールを使用して構造化された結果を返してください

ネイティブから見た不自然度(1.0が最も不自然, 0.0が自然)で並び替えてください。
`;
  }

  parseStructuredResponse(data: ClaudeAPIResponse): CorrectionResult {
    try {
      console.log('Raw API response:', data);

      // Structured Outputsの場合、tool_useの結果を確認
      if (data.content && data.content.length > 0) {
        const toolUse = data.content.find(item => item.type === 'tool_use');

        if (toolUse && toolUse.name === 'correction_response' && toolUse.input) {
          const input = toolUse.input;

          // スキーマ通りのデータを返す
          return {
            correctedText: input.correctedText || '',
            issues: Array.isArray(input.issues) ? input.issues : [],
            score: typeof input.score === 'number' ? input.score : 0,
            needsCorrection: Boolean(input.needsCorrection)
          };
        }

        // テキストレスポンスの場合（フォールバック）
        const textContent = data.content.find(item => item.type === 'text');
        if (textContent && textContent.text) {
          return this.parseResponse(textContent.text);
        }
      }

      throw new Error('Invalid response structure');

    } catch (error) {
      console.error('Structured response parsing error:', error);
      // フォールバック
      return {
        correctedText: '',
        issues: [],
        score: 0,
        needsCorrection: false
      };
    }
  }

  parseResponse(responseText: string): CorrectionResult {
    try {
      // JSONを抽出（マークダウンコードブロックがある場合に対応）
      const jsonMatch = responseText.match(/```json\n?([\s\S]*?)\n?```/) ||
                       responseText.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const jsonText = jsonMatch[1] || jsonMatch[0];
        const parsed = JSON.parse(jsonText);

        // 必要なプロパティが存在するかチェック
        return {
          correctedText: parsed.correctedText || '',
          issues: Array.isArray(parsed.issues) ? parsed.issues : [],
          score: typeof parsed.score === 'number' ? parsed.score : 0,
          needsCorrection: Boolean(parsed.needsCorrection)
        };
      } else {
        throw new Error('Invalid response format');
      }
    } catch (error) {
      console.error('Response parsing error:', error);
      // フォールバック：基本的なレスポンス
      return {
        correctedText: responseText,
        issues: [],
        score: 0,
        needsCorrection: false
      };
    }
  }
}

// サービスワーカー初期化
const claudeService = new ClaudeAPIService();

// 拡張機能インストール時の初期設定
chrome.runtime.onInstalled.addListener(() => {
  console.log('Slack Message Correction extension installed');
});