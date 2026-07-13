import { isTextBlock, type NativeChatMessage } from '../../../shared/native-chat-types'
import type { WebChatAgent } from '../../../shared/ai-vault-types'

// Why: 로컬 에이전트가 웹 대화를 "이전 대화"로 읽고 이어가도록 역할 라벨을 보존해
// 한 덩어리 텍스트로 평탄화한다. 웹 메시지는 text 블록만 갖는다(첨부는 범위 밖).
const AGENT_SOURCE_LABEL: Record<WebChatAgent, string> = {
  chatgpt: 'ChatGPT',
  'claude-web': 'Claude',
  'gemini-web': 'Gemini'
}

function messageText(message: NativeChatMessage): string {
  return message.blocks
    .filter(isTextBlock)
    .map((block) => block.text)
    .join('\n')
    .trim()
}

export function buildWebChatResumeSeed(messages: NativeChatMessage[], agent: WebChatAgent): string {
  const turns: string[] = []
  for (const message of messages) {
    const text = messageText(message)
    if (!text) {
      continue
    }
    const label = message.role === 'user' ? 'User' : 'Assistant'
    turns.push(`${label}: ${text}`)
  }
  const preamble = `아래는 ${AGENT_SOURCE_LABEL[agent]}에서 가져온 이전 대화예요. 이어서 계속 대화해 주세요.`
  return [preamble, '', ...turns].join('\n')
}
