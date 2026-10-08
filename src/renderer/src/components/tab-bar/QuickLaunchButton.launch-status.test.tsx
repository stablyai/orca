// @vitest-environment happy-dom

import type { ReactNode } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredLaunchState } from '@/lib/structured-agent-session-launch-registry'
import type { StructuredLaunchAttempt } from '@/lib/structured-agent-session-launch-request'

vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({ detectedIds: ['claude', 'codex'] })
}))
vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
vi.mock('@/store', () => {
  const state = {
    settings: { defaultTuiAgent: 'codex', disabledTuiAgents: [] },
    worktreesByRepo: {},
    repos: [],
    openSettingsPage: vi.fn(),
    openSettingsTarget: vi.fn()
  }
  const useAppStore = Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
  return { useAppStore }
})
vi.mock('@/lib/agent-catalog', () => ({
  getAgentCatalog: () => [
    { id: 'claude', label: 'Claude' },
    { id: 'codex', label: 'Codex' }
  ],
  AgentIcon: ({ agent }: { agent: string }) => <span>{agent}</span>
}))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({
    children,
    disabled,
    title,
    onSelect
  }: { children: ReactNode } & DivProps) => (
    <div aria-disabled={disabled ? 'true' : 'false'} title={title} onClick={onSelect}>
      {children}
    </div>
  ),
  DropdownMenuShortcut: ({ children }: { children: ReactNode }) => <span>{children}</span>
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace('{{value0}}', values?.value0 ?? '')
}))
const launchMock = vi.hoisted(() => vi.fn())
const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError, message: vi.fn(), success: vi.fn() } }))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: launchMock }))

type DivProps = { disabled?: boolean; title?: string; onSelect?: () => void }

import { QuickLaunchAgentMenuItems } from './QuickLaunchButton'
import {
  resetStructuredAgentLaunchRegistryForTests,
  setStructuredLaunchState
} from '@/lib/structured-agent-session-launch-registry'

const WORKTREE_ID = 'worktree-1'

function registerLaunch(
  agent: 'claude' | 'codex',
  outcome: 'pending' | 'failed',
  attempt: StructuredLaunchAttempt = {
    kind: 'first',
    requestId: `${agent}-pick`,
    blank: true,
    stagedPrompt: null
  }
): void {
  const sessionId = `${agent}-session`
  setStructuredLaunchState({
    identity: `${agent}:${WORKTREE_ID}`,
    intent: {
      worktreeId: WORKTREE_ID,
      sessionId,
      executionHostId: 'local',
      target: { kind: 'local' },
      agent,
      params: {
        envelope: {
          sessionId,
          clientOperationId: `operation-${sessionId}`,
          expectedRuntimeFence: null,
          payloadFingerprint: `fingerprint-${sessionId}`
        },
        worktree: `id:${WORKTREE_ID}`,
        agent
      }
    },
    promptDelivery: undefined,
    callers: {
      outcome,
      attempt,
      entries: new Set(),
      promptDeliveryResults: new Set(),
      onSettled: () => undefined
    },
    promise: new Promise(() => undefined),
    visibilityUnknown: false,
    cancelled: false,
    selection: { held: {} }
  } satisfies StructuredLaunchState)
}

function agentRowDisabled(label: string): string | null | undefined {
  return document
    .querySelector(`[title="Launch ${label} in a new terminal"]`)
    ?.getAttribute('aria-disabled')
}

describe('QuickLaunchAgentMenuItems launches', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStructuredAgentLaunchRegistryForTests()
  })
  afterEach(cleanup)

  // Each pick is its own request, so a chat starting, failing or retrying never blocks one.
  it('keeps every agent launchable while chats start, fail or retry', () => {
    registerLaunch('claude', 'pending')
    registerLaunch('codex', 'failed')

    render(
      <QuickLaunchAgentMenuItems
        worktreeId={WORKTREE_ID}
        groupId="group-1"
        onFocusTerminal={vi.fn()}
      />
    )
    expect(agentRowDisabled('Claude')).toBe('false')
    expect(agentRowDisabled('Codex')).toBe('false')
    cleanup()

    registerLaunch('codex', 'pending', { kind: 'retry' })
    render(
      <QuickLaunchAgentMenuItems
        worktreeId={WORKTREE_ID}
        groupId="group-1"
        onFocusTerminal={vi.fn()}
        prompt="review notes"
      />
    )
    expect(agentRowDisabled('Codex')).toBe('false')
  })

  it('gives each pick its own request, so a second pick opens its own chat', () => {
    launchMock.mockReset()
    launchMock.mockReturnValue({
      surface: { kind: 'host-published' }
    })
    render(
      <QuickLaunchAgentMenuItems
        worktreeId={WORKTREE_ID}
        groupId="group-1"
        onFocusTerminal={vi.fn()}
        prompt="review notes"
      />
    )
    const codexRow = document.querySelector('[title="Launch Codex in a new terminal"]')!
    fireEvent.click(codexRow)
    fireEvent.click(codexRow)

    const requestIds = launchMock.mock.calls.map(([args]) => args.requestId)
    expect(requestIds).toHaveLength(2)
    expect(requestIds[0]).toEqual(expect.any(String))
    expect(requestIds[1]).not.toBe(requestIds[0])
  })

  // Why: the notes menu holds what it sent until this result, so a second send leaves them out.
  it("hands the launch's own delivery outcome to the notes menu", async () => {
    const delivery = Promise.resolve({ delivered: true, failureNotified: false })
    launchMock.mockReturnValue({
      surface: { kind: 'host-published' },
      promptDeliveryResult: delivery
    })
    const onPromptHandedOff = vi.fn()

    render(
      <QuickLaunchAgentMenuItems
        worktreeId={WORKTREE_ID}
        groupId="group-1"
        onFocusTerminal={vi.fn()}
        prompt="review notes"
        promptDelivery="submit-after-ready"
        onPromptHandedOff={onPromptHandedOff}
      />
    )
    fireEvent.click(document.querySelector('[title="Launch Codex in a new terminal"]')!)

    expect(onPromptHandedOff).toHaveBeenCalledOnce()
    await expect(onPromptHandedOff.mock.calls[0][0]).resolves.toEqual({ delivered: true })
  })

  // The notes keep their text, so they are the one place that says it did not go.
  it('tells the notes menu once why its notes did not reach the new agent', async () => {
    launchMock.mockReturnValue({
      surface: { kind: 'host-published' },
      promptDeliveryResult: Promise.resolve({
        delivered: false,
        failureNotified: false,
        unconfirmed: true
      })
    })
    toastError.mockClear()

    render(
      <QuickLaunchAgentMenuItems
        worktreeId={WORKTREE_ID}
        groupId="group-1"
        onFocusTerminal={vi.fn()}
        prompt="review notes"
        promptDelivery="submit-after-ready"
        onPromptHandedOff={vi.fn()}
      />
    )
    fireEvent.click(document.querySelector('[title="Launch Codex in a new terminal"]')!)

    await vi.waitFor(() => expect(toastError).toHaveBeenCalledOnce())
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("Couldn't send to"), {
      description: expect.stringContaining("Orca couldn't confirm your message reached the agent")
    })
  })

  it('starts no agent when the menu has nothing left to send', () => {
    launchMock.mockClear()
    render(
      <QuickLaunchAgentMenuItems
        worktreeId={WORKTREE_ID}
        groupId="group-1"
        onFocusTerminal={vi.fn()}
        prompt=""
        disabled
      />
    )

    expect(agentRowDisabled('Codex')).toBe('true')
    fireEvent.click(document.querySelector('[title="Launch Codex in a new terminal"]')!)
    expect(launchMock).not.toHaveBeenCalled()
  })
})
