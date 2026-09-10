import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  startStructuredAgentLaunch: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  preflightAgentTrust: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, value: string) => value }))

vi.mock('@/lib/structured-agent-session-launch', () => ({
  startStructuredAgentLaunch: mocks.startStructuredAgentLaunch
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('@/lib/agent-trust-preflight', () => ({
  preflightAgentTrust: mocks.preflightAgentTrust
}))

vi.mock('@/lib/launch-structured-agent-session', () => ({
  StructuredAgentSessionCreateRefusalError: class extends Error {}
}))

vi.mock('@/lib/native-chat-transcript-readability', () => ({
  isNativeChatTranscriptLocalReadable: vi.fn(() => true)
}))

import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-agent-session'
import { settleDirectWorkItemStructuredLaunch } from './launch-work-item-direct-agent-routing'

const baseArgs = {
  structuredLaunch: true,
  agent: 'codex' as const,
  worktreeId: 'worktree-1',
  workspacePath: '/repo/worktree',
  connectionId: null,
  draftContent: 'Fix the route',
  promptDelivery: 'draft' as const,
  structuredSessionRequired: false,
  primaryTabId: null,
  startupPlan: null,
  launchSource: 'task_page' as const
}

describe('settleDirectWorkItemStructuredLaunch', () => {
  beforeEach(() => vi.clearAllMocks())

  it('runs the legacy terminal fallback after a definitive refusal', async () => {
    mocks.activateAndRevealWorktree.mockReturnValue({ primaryTabId: 'fallback-tab' })
    mocks.startStructuredAgentLaunch.mockReturnValue({
      launchResult: Promise.reject(new StructuredAgentSessionCreateRefusalError('unsupported')),
      isVisibilityUnknown: () => false,
      claimDefinitiveRefusalFallback: (fallback: () => Promise<unknown>) =>
        Promise.resolve()
          .then(fallback)
          .then(() => true)
    })

    await expect(settleDirectWorkItemStructuredLaunch(baseArgs)).resolves.toEqual({
      completed: false,
      succeeded: false,
      structuredLaunch: false,
      visibilityUnknown: false,
      primaryTabId: 'fallback-tab'
    })
  })

  it('fails closed without a terminal fallback when structured Start is refused', async () => {
    const claimDefinitiveRefusalFallback = vi.fn(() => Promise.resolve(false))
    mocks.startStructuredAgentLaunch.mockReturnValue({
      launchResult: Promise.reject(new StructuredAgentSessionCreateRefusalError('unsupported')),
      isVisibilityUnknown: () => false,
      claimDefinitiveRefusalFallback
    })

    await expect(
      settleDirectWorkItemStructuredLaunch({
        ...baseArgs,
        promptDelivery: 'submit-after-ready',
        structuredSessionRequired: true
      })
    ).resolves.toEqual({
      completed: true,
      succeeded: false,
      structuredLaunch: true,
      visibilityUnknown: false,
      primaryTabId: null
    })
    expect(claimDefinitiveRefusalFallback).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('reports an unknown outcome without starting a fallback terminal', async () => {
    mocks.startStructuredAgentLaunch.mockReturnValue({
      launchResult: Promise.reject(new Error('connection lost')),
      isVisibilityUnknown: () => true,
      claimDefinitiveRefusalFallback: vi.fn(() => Promise.resolve(false))
    })

    await expect(settleDirectWorkItemStructuredLaunch(baseArgs)).resolves.toEqual({
      completed: false,
      succeeded: false,
      structuredLaunch: true,
      visibilityUnknown: true,
      primaryTabId: null
    })
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('waits for authoritative structured prompt acceptance before succeeding', async () => {
    const delivery = Promise.withResolvers<{ delivered: boolean; failureNotified: boolean }>()
    mocks.startStructuredAgentLaunch.mockReturnValue({
      launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
      promptDeliveryResult: delivery.promise,
      isVisibilityUnknown: () => false,
      claimDefinitiveRefusalFallback: vi.fn(() => Promise.resolve(false))
    })

    let settled = false
    const result = settleDirectWorkItemStructuredLaunch({
      ...baseArgs,
      promptDelivery: 'submit-after-ready',
      structuredSessionRequired: true
    }).then((value) => {
      settled = true
      return value
    })
    await Promise.resolve()

    expect(settled).toBe(false)
    expect(mocks.startStructuredAgentLaunch).toHaveBeenCalledOnce()
    expect(mocks.startStructuredAgentLaunch).toHaveBeenCalledWith('worktree-1', 'codex', {
      prompt: 'Fix the route',
      promptDelivery: 'submit-after-ready',
      launchOrigin: 'work-item-start'
    })

    delivery.resolve({ delivered: true, failureNotified: false })
    await expect(result).resolves.toEqual({
      completed: true,
      succeeded: true,
      structuredLaunch: true,
      visibilityUnknown: false,
      primaryTabId: null
    })
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('fails closed when the structured host cannot accept the prompt', async () => {
    mocks.startStructuredAgentLaunch.mockReturnValue({
      launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
      promptDeliveryResult: Promise.resolve({ delivered: false, failureNotified: false }),
      isVisibilityUnknown: () => false,
      claimDefinitiveRefusalFallback: vi.fn(() => Promise.resolve(false))
    })

    await expect(
      settleDirectWorkItemStructuredLaunch({
        ...baseArgs,
        promptDelivery: 'submit-after-ready',
        structuredSessionRequired: true
      })
    ).resolves.toMatchObject({ completed: true, succeeded: false })
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(
      'The structured agent session did not accept the work item prompt. Orca did not retry or start another writer.'
    )
  })
})
