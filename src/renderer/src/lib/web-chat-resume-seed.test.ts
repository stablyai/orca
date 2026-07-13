import { expect, test } from 'vitest'
import type { NativeChatMessage } from '../../../shared/native-chat-types'
import { buildWebChatResumeSeed } from './web-chat-resume-seed'

const msg = (role: NativeChatMessage['role'], text: string, i: number): NativeChatMessage => ({
  id: `m${i}`,
  role,
  blocks: [{ type: 'text', text }],
  timestamp: i,
  source: 'transcript'
})

test('역할 라벨 + 프리앰블로 평탄화', () => {
  const seed = buildWebChatResumeSeed(
    [msg('user', '안녕', 0), msg('assistant', '반가워', 1)],
    'gemini-web'
  )
  expect(seed).toBe(
    '아래는 Gemini에서 가져온 이전 대화예요. 이어서 계속 대화해 주세요.\n\nUser: 안녕\nAssistant: 반가워'
  )
})

test('source별 라벨 매핑', () => {
  expect(buildWebChatResumeSeed([msg('user', 'x', 0)], 'chatgpt')).toContain('ChatGPT에서')
  expect(buildWebChatResumeSeed([msg('user', 'x', 0)], 'claude-web')).toContain('Claude에서')
})

test('빈 텍스트 메시지는 스킵', () => {
  const seed = buildWebChatResumeSeed([msg('user', '', 0), msg('assistant', '답', 1)], 'gemini-web')
  expect(seed).not.toContain('User:')
  expect(seed).toContain('Assistant: 답')
})
