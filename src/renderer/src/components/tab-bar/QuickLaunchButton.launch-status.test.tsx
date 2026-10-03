// @vitest-environment happy-dom

import type { ReactNode } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredLaunchState } from '@/lib/structured-agent-session-launch-registry'

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
  DropdownMenuItem: ({ children, disabled, title }: { children: ReactNode } & DivProps) => (
    <div aria-disabled={disabled ? 'true' : 'false'} title={title}>
      {children}
    </div>
  ),
  DropdownMenuShortcut: ({ children }: { children: ReactNode }) => <span>{children}</span>
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace('{{value0}}', values?.value0 ?? '')
}))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: vi.fn() }))

type DivProps = { disabled?: boolean; title?: string }

import { QuickLaunchAgentMenuItems } from './QuickLaunchButton'
import {
  resetStructuredAgentLaunchRegistryForTests,
  setStructuredLaunchState
} from '@/lib/structured-agent-session-launch-registry'

const WORKTREE_ID = 'worktree-1'

function registerLaunch(agent: 'claude' | 'codex', outcome: 'pending' | 'failed'): void {
  const sessionId = `${agent}-session`
  setStructuredLaunchState({
    identity: `${agent}:${WORKTREE_ID}`,
    intent: {
      worktreeId: WORKTREE_ID,
      sessionId,
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

describe('QuickLaunchAgentMenuItems launch status', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStructuredAgentLaunchRegistryForTests()
  })
  afterEach(cleanup)

  it('keeps an agent whose chat failed to start launchable while a starting one waits', () => {
    registerLaunch('claude', 'pending')
    registerLaunch('codex', 'failed')

    render(
      <QuickLaunchAgentMenuItems
        worktreeId={WORKTREE_ID}
        groupId="group-1"
        onFocusTerminal={vi.fn()}
      />
    )

    expect(agentRowDisabled('Claude')).toBe('true')
    expect(agentRowDisabled('Codex')).toBe('false')
  })
})
