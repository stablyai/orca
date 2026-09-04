import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  startStructuredCodexLaunch: vi.fn(),
  activateStructuredAgentSessionById: vi.fn()
}))

vi.mock('@/lib/structured-agent-session-launch', () => ({
  startStructuredCodexLaunch: mocks.startStructuredCodexLaunch
}))

vi.mock('@/lib/structured-agent-session-tab-activation', () => ({
  activateStructuredAgentSessionById: mocks.activateStructuredAgentSessionById
}))

vi.mock('@/lib/launch-structured-codex-session', () => ({
  StructuredAgentSessionCreateRefusalError: class extends Error {}
}))

import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-codex-session'
import { settleFullCreationStructuredLaunch } from './full-creation-structured-launch'

describe('settleFullCreationStructuredLaunch', () => {
  beforeEach(() => vi.clearAllMocks())

  it('runs the legacy terminal fallback after a definitive refusal', async () => {
    const fallbackActivation = { primaryTabId: 'fallback-tab' }
    const onDefinitiveRefusal = vi.fn().mockResolvedValue(fallbackActivation)
    mocks.startStructuredCodexLaunch.mockReturnValue({
      launchResult: Promise.reject(new StructuredAgentSessionCreateRefusalError('unsupported')),
      isVisibilityUnknown: () => false,
      claimDefinitiveRefusalFallback: (fallback: () => Promise<unknown>) =>
        Promise.resolve()
          .then(fallback)
          .then(() => true)
    })

    await expect(
      settleFullCreationStructuredLaunch({
        structuredLaunch: true,
        agent: 'codex',
        worktreeId: 'worktree-1',
        prompt: 'Fix the route',
        initialActivation: false,
        onDefinitiveRefusal
      })
    ).resolves.toEqual({
      structuredLaunchAccepted: false,
      visibilityUnknown: false,
      activation: fallbackActivation
    })
    expect(onDefinitiveRefusal).toHaveBeenCalledOnce()
  })

  it('reports an unknown outcome without starting a fallback terminal', async () => {
    const onDefinitiveRefusal = vi.fn()
    mocks.startStructuredCodexLaunch.mockReturnValue({
      launchResult: Promise.reject(new Error('connection lost')),
      isVisibilityUnknown: () => true,
      claimDefinitiveRefusalFallback: vi.fn(() => Promise.resolve(false))
    })

    await expect(
      settleFullCreationStructuredLaunch({
        structuredLaunch: true,
        agent: 'codex',
        worktreeId: 'worktree-1',
        prompt: 'Fix the route',
        initialActivation: false,
        onDefinitiveRefusal
      })
    ).resolves.toEqual({
      structuredLaunchAccepted: true,
      visibilityUnknown: true,
      activation: false
    })
    expect(onDefinitiveRefusal).not.toHaveBeenCalled()
  })
})
