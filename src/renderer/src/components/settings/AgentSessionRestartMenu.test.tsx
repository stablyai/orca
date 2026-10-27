// @vitest-environment happy-dom

import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRestartMenuRow } from '@/lib/agent-session-restart-plan'
import type { AgentSessionRestartOutcome } from '@/lib/agent-session-restart-run'

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect
  }: {
    children: ReactNode
    disabled?: boolean
    onSelect?: () => void
    'data-testid'?: string
  }) => (
    <button type="button" disabled={disabled} onClick={() => onSelect?.()}>
      {children}
    </button>
  )
}))

import { AgentSessionRestartMenuView } from './AgentSessionRestartMenu'

const rows: AgentSessionRestartMenuRow[] = [
  { agent: 'claude', label: 'Claude', liveCount: 2, disabled: false },
  { agent: 'codex', label: 'Codex', liveCount: 0, disabled: true },
  { agent: 'grok', label: 'Grok', liveCount: 1, disabled: false }
]

const outcomes: AgentSessionRestartOutcome[] = [
  {
    ptyId: 'pty-grok',
    agent: 'grok',
    label: 'Grok',
    workspaceLabel: 'repo',
    status: 'succeeded',
    message: 'new process started with original session resume command',
    newPtyId: 'pty-new',
    reapPtyId: null
  }
]

describe('AgentSessionRestartMenuView', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = null
    container = null
  })

  it('restarts one CLI, disables a zero count, and lists a verified result', () => {
    const onRestart = vi.fn()
    const onDismiss = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root?.render(
        <AgentSessionRestartMenuView
          rows={rows}
          unavailable={['Codex: no saved conversation ID yet; complete a turn and try again']}
          restartAllCount={3}
          outcomes={outcomes}
          running={false}
          onRestart={onRestart}
          onDismiss={onDismiss}
        />
      )
    })

    const buttons = [...container.querySelectorAll('button')]
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Restart agents',
      'Restart all agents (3)',
      'Claude (2)',
      'Codex (0)',
      'Grok (1)',
      'Details',
      'Dismiss'
    ])
    expect(container.querySelector('[data-testid="agent-session-restart-unavailable"]')).toBeNull()
    expect(container.querySelector('[data-testid="agent-session-restart-results"]')).toBeNull()
    act(() => buttons[5]?.click())
    expect(buttons[3]?.disabled).toBe(true)
    buttons[2]?.click()
    expect(onRestart).toHaveBeenCalledWith('claude')
    expect(container.textContent).toContain(
      'Restarted: Grok — new process started with original session resume command'
    )
    expect(container.textContent).toContain('1 restarted')
    act(() => buttons[6]?.click())
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
