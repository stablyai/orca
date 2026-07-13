// @vitest-environment happy-dom

import React from 'react'
import { render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

// Why: composer/message-list/interactive-card는 거대한 모듈 그래프(코드 에디터·
// react-markdown)라 전체 마운트가 멎는다. live-session 훅과 함께 스텁으로 대체해
// EditorPanel이 web-chat-transcript 모드에서 read-only native-chat 표면을
// 마운트하는지(=composer 부재 + 메시지 텍스트 노출)만 결정적으로 검증한다.
vi.mock('@/components/native-chat/NativeChatComposer', () => ({
  NativeChatComposer: React.forwardRef<HTMLTextAreaElement>((_props, ref) => (
    <textarea ref={ref} data-testid="composer-stub" />
  ))
}))
vi.mock('@/components/native-chat/NativeChatInteractiveCard', () => ({
  NativeChatInteractiveCard: () => null
}))
vi.mock('@/components/native-chat/NativeChatMessageList', () => ({
  NativeChatMessageList: ({
    session
  }: {
    session: { messages: { blocks: { text?: string }[] }[] }
  }) => (
    <div data-testid="messages-stub">
      {session.messages
        .flatMap((message) => message.blocks.map((block) => block.text ?? ''))
        .join('')}
    </div>
  )
}))
// Why: 훅이 렌더마다 새 객체를 반환하면 [session.messages] 의존 effect가 무한
// 재렌더를 유발한다(hang). 팩토리에서 한 번만 만든 안정적 참조를 반환한다.
vi.mock('@/components/native-chat/use-native-chat-live-session', () => {
  const session = {
    messages: [
      {
        id: 'm0',
        role: 'assistant',
        blocks: [{ type: 'text', text: '안녕' }],
        timestamp: 1,
        source: 'transcript'
      }
    ],
    status: 'ready',
    sessionId: 'GEMINI/c_1',
    agent: 'gemini-web',
    hasMore: false,
    loadingEarlier: false,
    loadEarlier: () => {}
  }
  return { useNativeChatLiveSession: () => session }
})

import { useAppStore } from '@/store'
import EditorPanel from './EditorPanel'

const FILE_ID = 'web-chat-transcript::gemini-web::GEMINI/c_1'

beforeEach(() => {
  useAppStore.setState({ openFiles: [], activeFileId: null } as never)
})

test('web-chat-transcript 활성 파일이면 read-only native-chat 표면을 마운트한다', () => {
  useAppStore.getState().openWebChatTranscript({
    agent: 'gemini-web',
    sessionId: 'GEMINI/c_1',
    title: '표 대화',
    worktreeId: 'w1'
  })
  render(<EditorPanel activeFileId={FILE_ID} />)
  // 메시지 텍스트가 보이고(=NativeChatResolvedView 마운트),
  expect(screen.getByTestId('messages-stub').textContent).toContain('안녕')
  // composer는 read-only라 렌더되지 않는다.
  expect(screen.queryByTestId('composer-stub')).toBeNull()
})
