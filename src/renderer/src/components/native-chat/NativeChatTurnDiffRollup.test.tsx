// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { toast } from 'sonner'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { getDefaultSettings } from '../../../../shared/default-global-settings'
import { useAppStore } from '@/store'

import { TooltipProvider } from '../ui/tooltip'

import { NativeChatMessageList } from './NativeChatMessageList'
import { session, stubLayout, stubResizeObserver } from './native-chat-windowing-test-harness'
import { NativeChatLinkClickContext } from './native-chat-link-click-context'

vi.mock('sonner', () => ({ toast: vi.fn() }))

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

it('Hide turns the changed-files card off in every chat and the toast links to its setting', () => {
  const original = useAppStore.getState()
  const openSettingsPage = vi.fn()
  const openSettingsTarget = vi.fn()
  useAppStore.setState({
    settings: getDefaultSettings('/tmp'),
    updateSettings: async (updates: Partial<GlobalSettings>) => {
      useAppStore.setState((state) => ({ settings: { ...state.settings!, ...updates } }))
    },
    openSettingsPage,
    openSettingsTarget
  })
  try {
    const list = (
      <TooltipProvider>
        <NativeChatMessageList
          session={session(messages)}
          isWorking={false}
          expandSignal={false}
          settledTurns={new Map([['u', { startedAt: 1, workedSeconds: 2 }]])}
        />
      </TooltipProvider>
    )
    render(list)
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(useAppStore.getState().settings?.nativeChatTurnDiffSummary).toBe(false)
    expect(screen.queryByRole('button', { name: /\/repo\/greeting.ts/ })).toBeNull()
    expect(screen.getByText('Updated the greeting.')).toBeVisible()

    expect(toast).toHaveBeenCalledWith('Hidden', expect.anything())
    const { description } = vi.mocked(toast).mock.calls[0]![1] as { description: ReactElement }
    cleanup()
    render(description)
    fireEvent.click(screen.getByRole('button', { name: 'Settings › Chat' }))
    expect(openSettingsPage).toHaveBeenCalledTimes(1)
    expect(openSettingsTarget).toHaveBeenCalledWith({
      pane: 'chat',
      repoId: null,
      sectionId: 'chat-turn-diff-summary'
    })

    // A chat opened later stays without the card until the setting is turned back on.
    cleanup()
    render(list)
    expect(screen.queryByRole('button', { name: 'Hide' })).toBeNull()
    act(() => {
      useAppStore.setState((state) => ({
        settings: { ...state.settings!, nativeChatTurnDiffSummary: true }
      }))
    })
    expect(screen.getByRole('button', { name: /\/repo\/greeting.ts/ })).toBeVisible()
  } finally {
    useAppStore.setState(original, true)
  }
})
