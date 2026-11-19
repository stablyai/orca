// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { NativeChatWorkersProvider, useRereadWorkersOnNewRows } from './native-chat-workers-context'

const reread = vi.hoisted(() => vi.fn())
vi.mock('@/lib/orchestration-session-workers', () => ({
  rereadOrchestrationSessionWorkersOnNewRow: reread
}))

function Wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <NativeChatWorkersProvider target={{ kind: 'local' }} sessionId="chat">
      {children}
    </NativeChatWorkersProvider>
  )
}

it('asks the host again once per new transcript row, never per render', () => {
  const { rerender } = renderHook(({ rows }) => useRereadWorkersOnNewRows(rows), {
    wrapper: Wrapper,
    initialProps: { rows: 4 }
  })
  rerender({ rows: 4 })
  expect(reread).not.toHaveBeenCalled()
  // A --terminal start or a plain dispatch writes no start card, only its command's rows.
  rerender({ rows: 5 })
  rerender({ rows: 5 })
  expect(reread).toHaveBeenCalledTimes(1)
  expect(reread).toHaveBeenCalledWith({ kind: 'local' }, 'chat')
})
