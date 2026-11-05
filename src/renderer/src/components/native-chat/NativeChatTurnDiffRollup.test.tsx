// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'

import { TooltipProvider } from '../ui/tooltip'

import { NativeChatMessageList } from './NativeChatMessageList'
import { session, stubLayout, stubResizeObserver } from './native-chat-windowing-test-harness'
import { NativeChatLinkClickContext } from './native-chat-link-click-context'

const messages: NativeChatMessage[] = [
  {
    id: 'u',
    role: 'user',
    source: 'transcript',
    timestamp: 1,
    blocks: [{ type: 'text', text: 'Fix the greeting' }]
  },
  {
    id: 'work',
    role: 'assistant',
    source: 'transcript',
    timestamp: 2,
    blocks: [
      {
        type: 'tool-call',
        name: 'Bash',
        input: { command: 'inspect-private-diagnostic' },
        state: 'completed'
      },
      { type: 'tool-result', output: 'diagnostic-output' },
      {
        type: 'tool-call',
        name: 'Edit',
        input: {
          file_path: '/repo/greeting.ts',
          old_string: 'helloOld()',
          new_string: 'helloNew()'
        },
        state: 'completed'
      },
      { type: 'tool-result', output: 'The file /repo/greeting.ts has been updated successfully.' },
      { type: 'tool-call', name: 'Diff', input: { path: 'status.ts' } },
      { type: 'tool-result', output: '@@ -1 +1 @@\n-statusOld()\n+statusNew()' }
    ]
  },
  {
    id: 'answer',
    role: 'assistant',
    source: 'transcript',
    timestamp: 3,
    blocks: [{ type: 'text', text: 'Updated the greeting.' }]
  }
]
let restoreLayout = (): void => {}
let restoreResizeObserver = (): void => {}
beforeEach(() => {
  restoreLayout = stubLayout({ scrollGeometry: true, offsetChain: true })
  restoreResizeObserver = stubResizeObserver()
})
afterEach(() => {
  cleanup()
  restoreResizeObserver()
  restoreLayout()
})

it('keeps landed files visible after work folds, opens a patch in one click and survives history remount', () => {
  const onLinkClick = vi.fn()
  const view = (working: boolean) => (
    <TooltipProvider>
      <NativeChatLinkClickContext value={onLinkClick}>
        <NativeChatMessageList
          session={session(messages)}
          isWorking={working}
          expandSignal={false}
          settledTurns={working ? undefined : new Map([['u', { startedAt: 1, workedSeconds: 2 }]])}
        />
      </NativeChatLinkClickContext>
    </TooltipProvider>
  )
  const { rerender, unmount } = render(view(true))
  expect(screen.getByRole('button', { name: /\/repo\/greeting.ts/ })).toBeVisible()
  rerender(view(false))
  expect(screen.getByRole('button', { name: /\/repo\/greeting.ts/ })).toBeVisible()
  expect(screen.queryByText('diagnostic-output')).toBeNull()
  expect(screen.queryByText('helloNew()')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /\/repo\/greeting.ts/ }))
  expect(screen.getByText('helloOld()')).toBeVisible()
  expect(screen.getByText('helloNew()')).toBeVisible()
  fireEvent.click(screen.getByRole('link', { name: '/repo/greeting.ts' }))
  expect(onLinkClick).toHaveBeenCalledTimes(1)
  expect(screen.getByText('helloNew()')).toBeVisible()
  expect(screen.queryByText('statusNew()')).toBeNull()
  unmount()
  render(view(false))
  expect(screen.getByRole('button', { name: /status.ts/ })).toBeVisible()
  expect(screen.queryByText('diagnostic-output')).toBeNull()
})
