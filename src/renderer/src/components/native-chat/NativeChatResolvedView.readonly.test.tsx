// @vitest-environment happy-dom

import React from 'react'
import { render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

// Why: composer(코드 에디터)와 message list(react-markdown 스택)는 거대한 모듈
// 그래프라 vitest 변환 비용이 커서 전체 마운트가 멎는다. 이 둘과 live-session 훅을
// 스텁으로 대체해 그래프를 줄이고, readOnly가 composer/interactive card를 조건부
// 렌더하는지(=NativeChatView의 {!readOnly && …} 로직)만 결정적으로 검증한다.
vi.mock('./NativeChatComposer', () => ({
  NativeChatComposer: React.forwardRef<HTMLTextAreaElement>((_props, ref) => (
    <textarea ref={ref} data-testid="composer-stub" />
  ))
}))
vi.mock('./NativeChatInteractiveCard', () => ({
  NativeChatInteractiveCard: () => null
}))
vi.mock('./NativeChatMessageList', () => ({
  NativeChatMessageList: () => <div data-testid="messages-stub" />
}))
// Why: 훅이 렌더마다 새 객체를 반환하면 session.messages 참조가 매 렌더 바뀌어
// [session.messages] 의존 effect가 무한 재렌더를 유발한다(테스트 hang). 팩토리에서
// 한 번만 만든 안정적 참조를 반환해 identity를 고정한다.
vi.mock('./use-native-chat-live-session', () => {
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

import { NativeChatResolvedView } from './NativeChatView'

afterEach(() => vi.clearAllMocks())

const base = {
  paneKey: 'webchat:GEMINI/c_1',
  agent: 'gemini-web' as const,
  sessionId: 'GEMINI/c_1',
  transcriptPath: null,
  targetPtyId: null,
  terminalTabId: 'webchat:GEMINI/c_1'
}

test('readOnly=true면 composer가 렌더되지 않는다', () => {
  render(<NativeChatResolvedView {...base} readOnly />)
  expect(screen.queryByTestId('composer-stub')).toBeNull()
})

test('readOnly 없으면 composer가 렌더된다', () => {
  render(<NativeChatResolvedView {...base} />)
  expect(screen.queryByTestId('composer-stub')).not.toBeNull()
})
