// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { nativeChatTurnDiffs } from '../../../../shared/native-chat/tools/native-chat-turn-diffs'
import { NativeChatTurnDiffRollup } from './NativeChatTurnDiffRollup'
import { NativeChatMessageList } from './NativeChatMessageList'
import { session, stubLayout, stubResizeObserver } from './native-chat-windowing-test-harness'

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
    <NativeChatMessageList
      session={session(messages)}
      isWorking={working}
      expandSignal={false}
      onLinkClick={onLinkClick}
      settledTurns={working ? undefined : new Map([['u', { startedAt: 1, workedSeconds: 2 }]])}
    />
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

it('mounts a bounded file prefix and no patch bodies until a file is selected', () => {
  const many: NativeChatMessage[] = Array.from({ length: 200 }, (_, index) => ({
    id: `e${index}`,
    role: 'assistant',
    source: 'transcript',
    timestamp: index,
    blocks: [
      { type: 'tool-call', name: 'Diff', input: { path: `file-${index}.ts` } },
      { type: 'tool-result', output: `@@ -1 +1 @@\n-old-${index}\n+new-${index}` }
    ]
  }))
  const diff = nativeChatTurnDiffs(
    many,
    many.map(() => 'u')
  ).get('u')!
  const { container } = render(<NativeChatTurnDiffRollup diff={diff} />)
  expect(screen.getAllByRole('button', { name: /file-\d+.ts/ })).toHaveLength(20)
  expect(container.querySelectorAll('[data-native-chat-code-content]')).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: /file-0.ts/ }))
  expect(screen.getByText('new-0')).toBeVisible()
  expect(screen.queryByText('new-1')).toBeNull()
  expect(container.querySelectorAll('[data-native-chat-code-content]')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: /Show 180 more/ }))
  expect(screen.getByRole('button', { name: /file-199.ts/ })).toBeVisible()
})
