// @vitest-environment happy-dom

import React, { type ReactNode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'

const mocks = vi.hoisted(() => ({
  detectAgents: vi.fn(),
  launchContinuation: vi.fn(),
  settings: { defaultTuiAgent: 'codex', disabledTuiAgents: [] }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({ settings: mocks.settings })
}))
vi.mock('@/lib/launch-agent-session-continuation', () => ({
  detectAgentSessionContinuationAgents: mocks.detectAgents,
  launchAgentSessionContinuation: mocks.launchContinuation
}))
vi.mock('@/lib/agent-catalog', () => ({
  getAgentCatalog: () => ['claude', 'claude-agent-teams', 'codex'].map((id) => ({ id, label: id })),
  getAgentLabel: () => 'Codex'
}))
vi.mock('@/components/agent/AgentCombobox', () => ({
  default: ({
    value,
    allowBlankTerminal,
    agents
  }: {
    value: string | null
    allowBlankTerminal?: boolean
    agents: { id: string }[]
  }) =>
    React.createElement('div', {
      'data-agent': value ?? '',
      'data-options': agents.map((agent) => agent.id).join(','),
      'data-allow-blank': String(allowBlankTerminal === true)
    })
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
  Select: ({ children }: { children?: ReactNode }) => React.createElement('div', null, children),
  SelectContent: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  SelectItem: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  SelectTrigger: ({ children }: { children?: ReactNode }) =>
    React.createElement('button', null, children),
  SelectValue: () => React.createElement('span')
}))

import { AgentSessionContinuationDialog } from './AgentSessionContinuationDialog'

function request(worktreeId: string): AgentSessionContinuationRequest {
  return {
    source: { capturedText: 'previous session', sourceAgent: 'codex' },
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
    mocks.settings.defaultTuiAgent = 'codex'
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('cannot start with only the source agent available', async () => {
    mocks.detectAgents.mockResolvedValue(['codex'])
    await act(async () => {
      root.render(
        <AgentSessionContinuationDialog
          open
          request={{ ...request('wt'), avoidSourceAgent: true }}
          onOpenChange={vi.fn()}
        />
      )
    })
    const start = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Start New Session'
    )
    expect(start?.disabled).toBe(true)
    start?.click()
    expect(mocks.launchContinuation).not.toHaveBeenCalled()
  })

  it.each([
    ['claude', true, true],
    ['claude-agent-teams', true, true],
    ['claude', true, false],
    ['claude', false, true]
  ] as const)(
    'recovers from %s with family exclusion=%s and alternative=%s',
    async (sourceAgent, avoidSourceAgent, hasAlternative) => {
      mocks.settings.defaultTuiAgent = 'claude-agent-teams'
      mocks.detectAgents.mockResolvedValue(
        hasAlternative
          ? ['claude', 'claude-agent-teams', 'codex']
          : ['claude', 'claude-agent-teams']
      )
      await act(async () => {
        root.render(
          <AgentSessionContinuationDialog
            open
            request={{
              ...request('wt'),
              source: { sourceAgent, capturedText: 'Continue the review' },
              avoidSourceAgent
            }}
            onOpenChange={vi.fn()}
          />
        )
      })
      const selected = avoidSourceAgent ? (hasAlternative ? 'codex' : '') : sourceAgent
      const picker = container.querySelector('[data-agent]')
      expect(picker?.getAttribute('data-options')).toBe(
        avoidSourceAgent ? (hasAlternative ? 'codex' : '') : 'claude,claude-agent-teams,codex'
      )
      expect(picker?.getAttribute('data-agent')).toBe(selected)
      const start = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Start New Session'
      )
      expect(start?.disabled).toBe(!selected)
      await act(async () => start?.click())
      if (selected) {
        expect(mocks.launchContinuation).toHaveBeenCalledWith(
          expect.objectContaining({ agent: selected, worktreeId: 'wt' })
        )
      } else {
        expect(mocks.launchContinuation).not.toHaveBeenCalled()
      }
    }
  )

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
    // Why: continuing a chat needs an agent to resume it into.
    expect(container.querySelector('[data-allow-blank="false"]')).not.toBeNull()
  })
})
