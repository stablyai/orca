// @vitest-environment happy-dom

import React, { type ReactNode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNativeChatHandOff } from '../native-chat/use-native-chat-hand-off'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'

const mocks = vi.hoisted(() => ({
  capability: vi.fn(),
  detectAgents: vi.fn(),
  launchContinuation: vi.fn(),
  settings: { defaultTuiAgent: 'codex', disabledTuiAgents: [] }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: mocks.settings, unifiedTabsByWorktree: {} })
}))
vi.mock('@/lib/launch-agent-session-continuation', () => ({
  detectAgentSessionContinuationAgents: mocks.detectAgents,
  launchAgentSessionContinuation: mocks.launchContinuation
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  supportsStructuredAgentSessionContinuationContext: mocks.capability
}))
vi.mock('@/runtime/structured-conversation-name', () => ({
  useStructuredChatTabConversationName: () => 'Saved chat'
}))
vi.mock('@/lib/agent-catalog', () => ({
  getAgentCatalog: () => ['claude', 'claude-agent-teams', 'codex'].map((id) => ({ id, label: id })),
  getAgentLabel: () => 'Codex'
}))
vi.mock('@/components/agent/AgentCombobox', () => ({
  default: ({
    value,
    allowBlankTerminal,
    agents,
    disabled
  }: {
    value: string | null
    allowBlankTerminal?: boolean
    disabled?: boolean
    agents: { id: string }[]
  }) =>
    React.createElement('div', {
      'data-disabled': String(disabled),
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
  Select: ({ children, disabled }: { children?: ReactNode; disabled?: boolean }) =>
    React.createElement('fieldset', { disabled, 'data-context-select': true }, children),
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
    mocks.capability.mockResolvedValue(false)
    mocks.settings.defaultTuiAgent = 'codex'
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it.each(['chat', undefined] as const)(
    'labels useful %s fallback without promising older history',
    async (sourceKind) => {
      mocks.detectAgents.mockResolvedValue([])
      await act(async () =>
        root.render(
          <AgentSessionContinuationDialog
            open
            request={{
              ...request('wt'),
              initialCwd: '/inherited',
              source: { ...request('wt').source, sourceKind }
            }}
            onOpenChange={vi.fn()}
          />
        )
      )
      expect(container.textContent).toContain(
        sourceKind === 'chat' ? 'recent messages currently loaded' : 'captured text'
      )
      expect(container.textContent).not.toContain('reading older transcript details')
      expect(container.textContent).toContain('Starts in: /inherited')
    }
  )

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

  it('keeps the replacement chooser open when an earlier accepted launch completes', async () => {
    const cwd = `/repo/${'long-workspace-directory/'.repeat(12)}project`
    function Chat({ epoch }: { epoch: string }) {
      const handOff = useNativeChatHandOff({
        pane: {
          tabId: 'tab',
          sessionId: 'chat',
          agent: 'codex',
          isVisible: true,
          target: { kind: 'local' }
        },
        directory: { worktreeId: 'folder', worktreePath: cwd, runtimeEnvironmentId: null },
        epoch,
        messages: [
          {
            id: '1',
            source: 'transcript',
            role: 'user',
            timestamp: 1,
            blocks: [{ type: 'text', text: 'Saved task' }]
          }
        ],
        focusComposer: () => {}
      })
      return (
        <>
          <button onClick={() => handOff.open()}>Open hand-off</button>
          {handOff.dialog}
        </>
      )
    }
    const capability = Promise.withResolvers<boolean>()
    mocks.capability.mockReturnValueOnce(capability.promise)
    const launchA = Promise.withResolvers<boolean>()
    mocks.detectAgents.mockResolvedValue(['codex'])
    mocks.launchContinuation.mockReturnValueOnce(launchA.promise).mockResolvedValueOnce(true)
    const click = (text: string) =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === text)
        ?.click()
    await act(async () => root.render(<Chat epoch="a" />))
    await act(async () => click('Open hand-off'))
    expect(container.textContent).toContain('Preparing saved chat context')
    expect(container.textContent).toContain(`Starts in: ${cwd}`)
    expect(container.textContent).not.toMatch(
      /Detecting Agents|Uses captured|recent messages currently loaded/
    )
    const start = () =>
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Start New Session'
      )
    expect(start()?.disabled).toBe(true)
    expect(container.querySelector('[data-agent]')?.getAttribute('data-disabled')).toBe('true')
    expect(container.querySelector<HTMLFieldSetElement>('[data-context-select]')?.disabled).toBe(
      true
    )
    await act(async () => click('Cancel'))
    await act(async () => capability.resolve(false))
    expect(container.textContent).not.toContain('Start New Session')
    expect(mocks.detectAgents).not.toHaveBeenCalled()
    const replacementCapability = Promise.withResolvers<boolean>()
    mocks.capability.mockReturnValueOnce(replacementCapability.promise)
    await act(async () => click('Open hand-off'))
    expect(container.textContent).toContain(`Starts in: ${cwd}`)
    await act(async () => replacementCapability.resolve(false))
    expect(container.textContent).toContain(`Starts in: ${cwd}`)
    expect(start()?.disabled).toBe(false)
    await act(async () => click('Start New Session'))
    expect(container.querySelector('[data-agent]')?.getAttribute('data-disabled')).toBe('true')
    expect(container.querySelector<HTMLFieldSetElement>('[data-context-select]')?.disabled).toBe(
      true
    )
    expect(mocks.launchContinuation).toHaveBeenCalledOnce()
    await act(async () => root.render(<Chat epoch="b" />))
    await act(async () => click('Open hand-off'))
    await act(async () => launchA.resolve(true))
    expect(container.textContent).toContain('Start New Session')
    await act(async () => click('Start New Session'))
    expect(mocks.launchContinuation).toHaveBeenCalledTimes(2)
    expect(container.textContent).not.toContain('Start New Session')
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
    // Why: continuing a chat needs an agent to resume it into.
    expect(container.querySelector('[data-allow-blank="false"]')).not.toBeNull()
  })
})
