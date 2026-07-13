import { beforeEach, expect, test } from 'vitest'
import { useAppStore } from '@/store'

beforeEach(() => {
  useAppStore.setState({ openFiles: [] } as never)
})

test('openWebChatTranscript: web-chat-transcript OpenFile 생성', () => {
  useAppStore.getState().openWebChatTranscript({
    agent: 'gemini-web',
    sessionId: 'c_1',
    title: '표 대화',
    worktreeId: 'w1'
  })
  const files = useAppStore.getState().openFiles
  const created = files.find((f) => f.id === 'web-chat-transcript::gemini-web::c_1')
  expect(created).toBeDefined()
  expect(created?.mode).toBe('web-chat-transcript')
  expect(created?.webChatAgent).toBe('gemini-web')
  expect(created?.webChatSessionId).toBe('c_1')
})

test('openWebChatTranscript: 같은 대화 재호출은 중복 생성 안 함', () => {
  const open = () =>
    useAppStore.getState().openWebChatTranscript({
      agent: 'gemini-web',
      sessionId: 'c_1',
      title: '표 대화',
      worktreeId: 'w1'
    })
  open()
  open()
  const count = useAppStore
    .getState()
    .openFiles.filter((f) => f.id === 'web-chat-transcript::gemini-web::c_1').length
  expect(count).toBe(1)
})
