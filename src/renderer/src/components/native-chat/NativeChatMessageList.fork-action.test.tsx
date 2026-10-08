// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { NativeChatForkContext } from './native-chat-fork-context'
import { NativeChatMessageList } from './NativeChatMessageList'
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'
import type { NativeChatLiveSession } from './use-native-chat-live-session'

let restoreViewport = (): void => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => restoreViewport())
afterEach(cleanup)

function turn(id: string, at: number): NativeChatMessage[] {
  return [
    { id, role: 'user', blocks: [{ type: 'text', text: id }], timestamp: at, source: 'transcript' },
    {
      id: `${id}-answer`,
      role: 'assistant',
      blocks: [{ type: 'text', text: `answer ${id}` }],
      timestamp: at + 1,
      source: 'transcript'
    }
  ]
}

function session(): NativeChatLiveSession {
  return {
    messages: [...turn('first', 0), ...turn('second', 10)],
    status: 'ready',
    sessionId: 'session-1',
    agent: 'codex',
    hasMore: false,
    loadingEarlier: false,
    olderHistoryGeneration: 0,
    loadEarlier: vi.fn(),
    readPhase: 'ready'
  }
}

const fork = vi.fn()
const SURFACE = { rows: new Set(['first-answer']), fork }

it('offers the fork on the answer its turn is forked from, and on no other row', () => {
  render(
    <TooltipProvider>
      <NativeChatForkContext.Provider value={SURFACE}>
        <NativeChatMessageList
          session={session()}
          isWorking={false}
          workingStartedAt={null}
          expandSignal={false}
        />
      </NativeChatForkContext.Provider>
    </TooltipProvider>
  )
  const buttons = screen.getAllByRole('button', { name: 'Fork from this turn' })
  fireEvent.click(buttons[0])

  expect(buttons).toHaveLength(1)
  expect(fork).toHaveBeenCalledWith('first-answer')
})

it('keeps the fork on an answer that more of its turn follows, folded or expanded', () => {
  const messages: NativeChatMessage[] = [
    ...turn('first', 0),
    {
      id: 'first-thought',
      role: 'reasoning',
      blocks: [{ type: 'text', text: 'checking the result' }],
      timestamp: 2,
      source: 'transcript'
    },
    {
      id: 'first-work',
      role: 'assistant',
      blocks: [
        { type: 'tool-call', name: 'shell', input: { command: 'pnpm test' }, state: 'completed' },
        { type: 'tool-result', output: 'ok' }
      ],
      timestamp: 3,
      source: 'transcript'
    }
  ]
  const forkButtons = () => screen.queryAllByRole('button', { name: 'Fork from this turn' })

  render(
    <TooltipProvider>
      <NativeChatForkContext.Provider value={SURFACE}>
        <NativeChatMessageList
          session={{ ...session(), messages }}
          isWorking={false}
          workingStartedAt={null}
          settledTurns={new Map([['first', { startedAt: 0, workedSeconds: 4 }]])}
          expandSignal={false}
        />
      </NativeChatForkContext.Provider>
    </TooltipProvider>
  )

  expect(forkButtons()).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Toggle turn details' }))
  expect(forkButtons()).toHaveLength(1)
})
