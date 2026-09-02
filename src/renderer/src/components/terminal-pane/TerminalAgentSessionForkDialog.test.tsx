import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreparedAgentSessionFork } from './terminal-agent-session-fork'

type CapturedButtonProps = {
  disabled?: boolean
  onClick?: () => void
  children?: React.ReactNode
}

const mocks = vi.hoisted(() => ({
  buttons: [] as CapturedButtonProps[],
  copyAgentSessionForkContext: vi.fn(),
  startAgentSessionFork: vi.fn(),
  startAgentSessionForkInSameWorktree: vi.fn()
}))

vi.mock('@/components/ui/button', async () => {
  const ReactModule = await import('react')
  return {
    Button: (props: CapturedButtonProps) => {
      mocks.buttons.push(props)
      return ReactModule.createElement('button', { disabled: props.disabled }, props.children)
    }
  }
})

vi.mock('@/components/ui/dialog', async () => {
  const ReactModule = await import('react')
  return {
    Dialog: ({ open, children }: { open: boolean; children?: React.ReactNode }) =>
      open ? ReactModule.createElement('div', null, children) : null,
    DialogContent: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement('div', null, children),
    DialogDescription: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement('p', null, children),
    DialogFooter: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement('footer', null, children),
    DialogHeader: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement('header', null, children),
    DialogTitle: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement('h2', null, children)
  }
})

// Why: the picker pulls the agent catalog, detection, and store; stub them so
// the dialog renders statically and the test stays focused on the button wiring.
vi.mock('@/components/agent/AgentCombobox', () => ({ default: () => null }))
vi.mock('@/lib/agent-catalog', () => ({ getAgentCatalog: () => [], AgentIcon: () => null }))
vi.mock('../../../../shared/tui-agent-selection', () => ({ filterEnabledTuiAgents: () => [] }))
vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({
    detectedIds: null,
    isLoading: false,
    isRefreshing: false,
    refresh: vi.fn()
  })
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settings: { disabledTuiAgents: [] },
      repos: [],
      getKnownWorktreeById: () => undefined,
      openSettingsPage: () => {},
      openSettingsTarget: () => {}
    })
}))

vi.mock('./terminal-agent-session-fork', () => ({
  copyAgentSessionForkContext: mocks.copyAgentSessionForkContext,
  startAgentSessionFork: mocks.startAgentSessionFork,
  startAgentSessionForkInSameWorktree: mocks.startAgentSessionForkInSameWorktree
}))

function makeFork(): PreparedAgentSessionFork {
  return {
    prompt: 'fork prompt',
    agent: null,
    worktreeId: 'wt-1',
    pane: {} as PreparedAgentSessionFork['pane']
  }
}

// Footer button order: [0] Copy context, [1] Fork in this worktree, [2] Create fork.
const COPY_CONTEXT_BUTTON = 0
const SAME_WORKTREE_BUTTON = 1
const CREATE_FORK_BUTTON = 2

describe('TerminalAgentSessionForkDialog', () => {
  beforeEach(() => {
    mocks.buttons = []
    mocks.copyAgentSessionForkContext.mockReset()
    mocks.startAgentSessionFork.mockReset()
    mocks.startAgentSessionForkInSameWorktree.mockReset()
  })

  it('renders copy, same-worktree, and create-fork actions', async () => {
    const { TerminalAgentSessionForkDialog } = await import('./TerminalAgentSessionForkDialog')

    renderToStaticMarkup(
      <TerminalAgentSessionForkDialog open fork={makeFork()} onOpenChange={vi.fn()} />
    )

    expect(mocks.buttons).toHaveLength(3)
    expect(mocks.buttons[COPY_CONTEXT_BUTTON]).toBeDefined()
    expect(mocks.buttons[SAME_WORKTREE_BUTTON]).toBeDefined()
    expect(mocks.buttons[CREATE_FORK_BUTTON]).toBeDefined()
  })

  it('prevents busy-state double submit for create', async () => {
    mocks.startAgentSessionFork.mockReturnValue(new Promise(() => undefined))
    const { TerminalAgentSessionForkDialog } = await import('./TerminalAgentSessionForkDialog')

    renderToStaticMarkup(
      <TerminalAgentSessionForkDialog open fork={makeFork()} onOpenChange={vi.fn()} />
    )

    const createButton = mocks.buttons[CREATE_FORK_BUTTON]
    expect(createButton).toBeDefined()

    createButton?.onClick?.()
    createButton?.onClick?.()

    expect(mocks.startAgentSessionFork).toHaveBeenCalledTimes(1)
  })

  it('routes the same-worktree button to the new-tab fork', async () => {
    mocks.startAgentSessionForkInSameWorktree.mockReturnValue(new Promise(() => undefined))
    const { TerminalAgentSessionForkDialog } = await import('./TerminalAgentSessionForkDialog')

    renderToStaticMarkup(
      <TerminalAgentSessionForkDialog open fork={makeFork()} onOpenChange={vi.fn()} />
    )

    mocks.buttons[SAME_WORKTREE_BUTTON]?.onClick?.()

    expect(mocks.startAgentSessionForkInSameWorktree).toHaveBeenCalledTimes(1)
    expect(mocks.startAgentSessionFork).not.toHaveBeenCalled()
  })
})
