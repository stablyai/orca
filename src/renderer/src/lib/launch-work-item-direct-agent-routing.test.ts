import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  startStructuredCodexLaunch: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  preflightAgentTrust: vi.fn()
}))

vi.mock('@/lib/structured-agent-session-launch', () => ({
  startStructuredCodexLaunch: mocks.startStructuredCodexLaunch
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('@/lib/agent-trust-preflight', () => ({
  preflightAgentTrust: mocks.preflightAgentTrust
}))

vi.mock('@/lib/launch-structured-codex-session', () => ({
  StructuredAgentSessionCreateRefusalError: class extends Error {}
}))

vi.mock('@/lib/native-chat-transcript-readability', () => ({
  isNativeChatTranscriptLocalReadable: vi.fn(() => true)
}))

import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-codex-session'
import { settleDirectWorkItemStructuredLaunch } from './launch-work-item-direct-agent-routing'

const baseArgs = {
  structuredLaunch: true,
  agent: 'codex' as const,
  worktreeId: 'worktree-1',
  workspacePath: '/repo/worktree',
  connectionId: null,
  draftContent: 'Fix the route',
  promptDelivery: 'draft' as const,
  primaryTabId: null,
  startupPlan: null,
  launchSource: 'task_page' as const
}

describe('settleDirectWorkItemStructuredLaunch', () => {
  beforeEach(() => vi.clearAllMocks())

  it('runs the legacy terminal fallback after a definitive refusal', async () => {
    mocks.activateAndRevealWorktree.mockReturnValue({ primaryTabId: 'fallback-tab' })
    mocks.startStructuredCodexLaunch.mockReturnValue({
      launchResult: Promise.reject(new StructuredAgentSessionCreateRefusalError('unsupported')),
      isVisibilityUnknown: () => false,
      claimDefinitiveRefusalFallback: (fallback: () => Promise<unknown>) =>
        Promise.resolve()
          .then(fallback)
          .then(() => true)
    })

    await expect(settleDirectWorkItemStructuredLaunch(baseArgs)).resolves.toEqual({
      completed: false,
      structuredLaunch: false,
      visibilityUnknown: false,
      primaryTabId: 'fallback-tab'
    })
  })

  it('reports an unknown outcome without starting a fallback terminal', async () => {
    mocks.startStructuredCodexLaunch.mockReturnValue({
      launchResult: Promise.reject(new Error('connection lost')),
      isVisibilityUnknown: () => true,
      claimDefinitiveRefusalFallback: vi.fn(() => Promise.resolve(false))
    })

    await expect(settleDirectWorkItemStructuredLaunch(baseArgs)).resolves.toEqual({
      completed: false,
      structuredLaunch: true,
      visibilityUnknown: true,
      primaryTabId: null
    })
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })
})
