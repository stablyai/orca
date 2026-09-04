// @vitest-environment happy-dom

import React, { type ReactNode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'

const mocks = vi.hoisted(() => ({
  detectAgents: vi.fn(),
  launchContinuation: vi.fn(),
  launchContinuationInNewWorktree: vi.fn(),
  settings: { defaultTuiAgent: 'codex', disabledTuiAgents: [] },
  repos: [{ id: 'repo-1', kind: 'git' }] as { id: string; kind: string }[]
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: mocks.settings, repos: mocks.repos })
}))
vi.mock('@/lib/launch-agent-session-continuation', () => ({
  detectAgentSessionContinuationAgents: mocks.detectAgents,
  launchAgentSessionContinuation: mocks.launchContinuation
}))
vi.mock('@/lib/launch-agent-session-continuation-worktree', () => ({
  launchAgentSessionContinuationInNewWorktree: mocks.launchContinuationInNewWorktree
}))
vi.mock('@/lib/agent-catalog', () => ({
  getAgentCatalog: () => [{ id: 'codex', label: 'Codex' }],
  getAgentLabel: () => 'Codex'
}))
vi.mock('@/components/agent/AgentCombobox', () => ({
  default: ({ value }: { value: string | null }) =>
    React.createElement('div', { 'data-agent': value ?? '' })
}))
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? React.createElement('div', null, children) : null,
  DialogContent: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  DialogDescription: ({ children }: { children?: ReactNode }) =>
    React.createElement('p', null, children),
  DialogFooter: ({ children }: { children?: ReactNode }) =>
    React.createElement('footer', null, children),
  DialogHeader: ({ children }: { children?: ReactNode }) =>
    React.createElement('header', null, children),
  DialogTitle: ({ children }: { children?: ReactNode }) => React.createElement('h2', null, children)
}))
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children
  }: {
    value?: string
    onValueChange?: (next: string) => void
    children?: ReactNode
  }) =>
    React.createElement(
      'select',
      {
        value,
        onChange: (event: { target: { value: string } }) => onValueChange?.(event.target.value)
      },
      children
    ),
  SelectContent: ({ children }: { children?: ReactNode }) => children,
  SelectItem: ({ value, children }: { value?: string; children?: ReactNode }) =>
    React.createElement('option', { value }, children),
  SelectTrigger: () => null,
  SelectValue: () => null
}))

import { AgentSessionContinuationDialog } from './AgentSessionContinuationDialog'

function request(worktreeId: string, sourceTitle?: string): AgentSessionContinuationRequest {
  return {
    source: {
      capturedText: 'previous session',
      sourceAgent: 'codex',
      ...(sourceTitle ? { sourceTitle } : {})
    },
    worktreeId,
    workspacePath: '/repo',
    launchSource: 'sidebar'
  }
}

describe('AgentSessionContinuationDialog', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('clears a prior detection failure while detecting a new request', async () => {
    let resolveSecond: (agents: ['codex']) => void = () => {}
    mocks.detectAgents.mockRejectedValueOnce(new Error('offline')).mockReturnValueOnce(
      new Promise<['codex']>((resolve) => {
        resolveSecond = resolve
      })
    )

    await act(async () => {
      root.render(
        <AgentSessionContinuationDialog open request={request('wt-1')} onOpenChange={vi.fn()} />
      )
    })
    await vi.waitFor(() => expect(container.textContent).toContain('Could not detect Agents'))

    act(() => {
      root.render(
        <AgentSessionContinuationDialog open request={request('wt-2')} onOpenChange={vi.fn()} />
      )
    })
    expect(container.textContent).toContain('Detecting Agents')
    expect(container.textContent).not.toContain('Could not detect Agents')

    await act(async () => resolveSecond(['codex']))
    await vi.waitFor(() => expect(container.querySelector('[data-agent="codex"]')).not.toBeNull())
  })

  it('offers a new worktree for a git workspace and seeds the branch from the tab title', async () => {
    mocks.detectAgents.mockResolvedValue(['codex'])

    await act(async () => {
      root.render(
        <AgentSessionContinuationDialog
          open
          request={request('repo-1::/repo/wt', '\u2733 RW-20595 nested components')}
          onOpenChange={vi.fn()}
        />
      )
    })

    expect(container.textContent).toContain('Destination')
    const destination = container.querySelectorAll('select')[1]
    expect(destination).toBeDefined()

    await act(async () => {
      destination.value = 'new-worktree'
      destination.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const branchInput = container.querySelector('input')
    expect(branchInput?.value).toBe('RW-20595')
  })

  it('hides the destination picker for a folder workspace', async () => {
    mocks.detectAgents.mockResolvedValue(['codex'])
    mocks.repos = [{ id: 'repo-1', kind: 'folder' }]

    await act(async () => {
      root.render(
        <AgentSessionContinuationDialog
          open
          request={request('repo-1::/repo/wt', 'RW-20595')}
          onOpenChange={vi.fn()}
        />
      )
    })

    expect(container.textContent).not.toContain('Destination')
    mocks.repos = [{ id: 'repo-1', kind: 'git' }]
  })

  it('creates the worktree instead of a tab when the destination is a new worktree', async () => {
    mocks.detectAgents.mockResolvedValue(['codex'])
    mocks.launchContinuationInNewWorktree.mockReturnValue(true)

    await act(async () => {
      root.render(
        <AgentSessionContinuationDialog
          open
          request={request('repo-1::/repo/wt', 'RW-20595')}
          onOpenChange={vi.fn()}
        />
      )
    })

    await act(async () => {
      const destination = container.querySelectorAll('select')[1]
      destination.value = 'new-worktree'
      destination.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const startButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Start New Session')
    )
    await act(async () => {
      startButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.launchContinuation).not.toHaveBeenCalled()
    expect(mocks.launchContinuationInNewWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: 'repo-1', branchName: 'RW-20595', agent: 'codex' })
    )
  })
})
