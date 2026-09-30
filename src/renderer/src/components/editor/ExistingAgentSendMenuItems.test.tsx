// @vitest-environment happy-dom

import React, { type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { ExistingAgentSendMenuItems } from './ReviewNotesSendMenuContent'

const TAB_A = 'tab-a'
const LEAF_A = '11111111-1111-4111-8111-111111111111'

type NoteTarget = {
  paneKey: string
  tabId: string
  leafId: string
  agentType: 'claude'
  tabTitle: string
  status: 'eligible' | 'disabled'
  disabledReason?: string
}

const harness = vi.hoisted(() => {
  const storeState: Record<string, unknown> = {
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    tabsByWorktree: { 'wt-1': [] },
    terminalLayoutsByTabId: {},
    ptyIdsByTabId: {},
    runtimePaneTitlesByTabId: {}
  }
  const noteTargets: NoteTarget[] = []
  return {
    storeState,
    sendNotesToActiveAgentSession: vi.fn(),
    track: vi.fn(),
    toastMessage: vi.fn(),
    noteTargets
  }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(harness.storeState),
    { getState: () => harness.storeState }
  )
}))
vi.mock('zustand/react/shallow', () => ({ useShallow: (selector: unknown) => selector }))
vi.mock('@/lib/active-agent-note-send', () => ({
  activeAgentNotesSendFailureMessage: (
    status: string,
    options: { explicitTarget?: boolean } = {}
  ) => (options.explicitTarget ? `selected:${status}` : status),
  sendNotesToActiveAgentSession: harness.sendNotesToActiveAgentSession
}))
vi.mock('@/lib/notes-send-agent-targets', () => ({
  deriveNotesSendAgentTargets: () => harness.noteTargets
}))
vi.mock('@/lib/telemetry', () => ({ track: harness.track }))
vi.mock('@/hooks/use-now', () => ({ useNow: () => 600_000 }))
vi.mock('@/components/sidebar/useWorktreeAgentRows', () => ({ useWorktreeAgentRows: () => [] }))
vi.mock('@/components/AgentStateDot', () => ({
  AgentStateDot: () => null,
  agentStateLabel: (state: string) => state
}))
vi.mock('@/lib/agent-catalog', () => ({ AgentIcon: () => null }))
vi.mock('@/components/tab-bar/QuickLaunchButton', () => ({ QuickLaunchAgentMenuItems: () => null }))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
// Why: Radix menus need pointer events happy-dom lacks; render rows as plain buttons.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect
  }: {
    children?: ReactNode
    disabled?: boolean
    onSelect?: () => void
  }) =>
    React.createElement(
      'button',
      { role: 'menuitem', disabled, onClick: () => onSelect?.() },
      children
    ),
  DropdownMenuLabel: () => null,
  DropdownMenuSeparator: () => null
}))
vi.mock('sonner', () => ({
  toast: {
    dismiss: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(() => 'toast-id'),
    message: harness.toastMessage,
    success: vi.fn()
  }
}))

const eligibleTarget: NoteTarget = {
  paneKey: makePaneKey(TAB_A, LEAF_A),
  tabId: TAB_A,
  leafId: LEAF_A,
  agentType: 'claude',
  tabTitle: 'Terminal 1',
  status: 'eligible'
}
const callbacks = {
  onSendStarted: vi.fn(),
  onPromptDelivered: vi.fn(),
  onSendFailed: vi.fn()
}

function renderItems(
  props: Partial<React.ComponentProps<typeof ExistingAgentSendMenuItems>> = {}
): HTMLButtonElement[] {
  render(
    <ExistingAgentSendMenuItems
      worktreeId="wt-1"
      prompt="Resolve the PR comments."
      launchSource="task_page"
      {...callbacks}
      {...props}
    />
  )
  return screen
    .queryAllByRole('menuitem')
    .filter((item): item is HTMLButtonElement => item instanceof HTMLButtonElement)
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve()
  }
}

describe('ExistingAgentSendMenuItems', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    harness.sendNotesToActiveAgentSession.mockResolvedValue({ status: 'sent' })
    harness.noteTargets = [eligibleTarget]
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('starts, delivers, and reports success with the caller copy', async () => {
    const [item] = renderItems({
      toastCopy: { sending: 'Sending prompt...', sent: 'Prompt sent.' }
    })
    fireEvent.click(item)
    expect(callbacks.onSendStarted).toHaveBeenCalledTimes(1)
    expect(callbacks.onPromptDelivered).not.toHaveBeenCalled()
    await flushMicrotasks()

    expect(harness.sendNotesToActiveAgentSession).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      prompt: 'Resolve the PR comments.',
      noteTarget: { tabId: TAB_A, leafId: LEAF_A }
    })
    expect(callbacks.onPromptDelivered).toHaveBeenCalledTimes(1)
    expect(callbacks.onSendFailed).not.toHaveBeenCalled()
    expect(toast.loading).toHaveBeenCalledWith('Sending prompt...')
    expect(toast.success).toHaveBeenCalledWith('Prompt sent.')
    expect(harness.track).toHaveBeenCalledWith('agent_prompt_sent', {
      agent_kind: 'claude-code',
      launch_source: 'task_page',
      request_kind: 'followup'
    })
  })

  it('reports an undelivered send as failed, never as delivered', async () => {
    harness.sendNotesToActiveAgentSession.mockResolvedValue({ status: 'partial-submit-failed' })
    fireEvent.click(renderItems()[0])
    await flushMicrotasks()

    expect(callbacks.onSendStarted).toHaveBeenCalledTimes(1)
    expect(callbacks.onSendFailed).toHaveBeenCalledTimes(1)
    expect(callbacks.onPromptDelivered).not.toHaveBeenCalled()
    expect(harness.toastMessage).toHaveBeenCalledWith('selected:partial-submit-failed')
  })

  it('reports a thrown send as failed', async () => {
    harness.sendNotesToActiveAgentSession.mockRejectedValue(new Error('relay gone'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fireEvent.click(renderItems()[0])
    await flushMicrotasks()

    expect(callbacks.onSendFailed).toHaveBeenCalledTimes(1)
    expect(callbacks.onPromptDelivered).not.toHaveBeenCalled()
  })

  it('refuses a target that went stale before the click without starting a send', () => {
    const [item] = renderItems()
    harness.noteTargets = [
      { ...eligibleTarget, status: 'disabled', disabledReason: 'Agent status is stale' }
    ]
    fireEvent.click(item)

    expect(harness.sendNotesToActiveAgentSession).not.toHaveBeenCalled()
    expect(callbacks.onSendStarted).not.toHaveBeenCalled()
    expect(callbacks.onSendFailed).not.toHaveBeenCalled()
    expect(harness.toastMessage).toHaveBeenCalledWith('Agent status is stale')
  })

  it('shows the empty label as a disabled row when no agent is running', () => {
    harness.noteTargets = []
    const items = renderItems({ emptyLabel: 'No running agents in this workspace' })

    expect(items).toHaveLength(1)
    expect(items[0].disabled).toBe(true)
    expect(items[0].textContent).toBe('No running agents in this workspace')
  })

  it('disables every target while the prompt is empty', () => {
    const items = renderItems({ prompt: '   ' })

    expect(items).toHaveLength(1)
    expect(items[0].disabled).toBe(true)
  })
})
