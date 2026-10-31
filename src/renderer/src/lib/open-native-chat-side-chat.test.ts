// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { openNativeChatSideChat } from './open-native-chat-side-chat'

const mocks = vi.hoisted(() => ({ begin: vi.fn(), support: vi.fn() }))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      unifiedTabsByWorktree: {
        workspace: [
          {
            id: 'parent-tab',
            contentType: 'agent-session',
            entityId: 'parent',
            agentSessionAgent: 'codex'
          }
        ]
      }
    })
  }
}))
vi.mock('@/runtime/structured-agent-session-owner', () => ({
  structuredAgentSessionOwnerForTab: () => 'local',
  structuredAgentSessionTargetForHost: () => ({ kind: 'local' })
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  supportsStructuredAgentSessionReadOnlySideChat: mocks.support,
  supportsStructuredAgentSessionSideChat: mocks.support
}))
vi.mock('./agent-session-launch-plan', () => ({
  adoptAgentSessionLaunchVerdict: (plan: unknown) => plan
}))
vi.mock('./agent-session/structured-agent-session-provisional-tab', () => ({
  beginStructuredAgentSessionProvisionalLaunch: mocks.begin
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.support.mockResolvedValue(true)
})

const source = { tabId: 'parent-tab', worktreeId: 'workspace', sessionId: 'parent' }

it.each([true, false])(
  'waits for first-question delivery and returns its outcome: %s',
  async (delivered) => {
    const delivery = Promise.withResolvers<{ delivered: boolean }>()
    mocks.begin.mockReturnValue({
      settlement: Promise.resolve({ kind: 'structured', promptDeliveryResult: delivery.promise })
    })
    let settled = false
    const opening = openNativeChatSideChat(source, 'Question').then((result) => {
      settled = true
      return result
    })
    try {
      await vi.waitFor(() => expect(mocks.begin).toHaveBeenCalledOnce())
      expect(settled).toBe(false)
    } finally {
      delivery.resolve({ delivered })
    }
    await expect(opening).resolves.toBe(delivered)
  }
)

it('accepts an empty side chat without a prompt-delivery receipt', async () => {
  mocks.begin.mockReturnValue({ settlement: Promise.resolve({ kind: 'structured' }) })
  await expect(openNativeChatSideChat(source)).resolves.toBe(true)
})

it('joins duplicate menu opens while pending, then permits another side chat after settlement', async () => {
  const settlement = Promise.withResolvers<{ kind: 'structured' }>()
  mocks.begin.mockReturnValue({ settlement: settlement.promise })
  const first = openNativeChatSideChat(source)
  const second = openNativeChatSideChat(source)
  try {
    await vi.waitFor(() => expect(mocks.begin).toHaveBeenCalledOnce())
  } finally {
    settlement.resolve({ kind: 'structured' })
  }
  await expect(Promise.all([first, second])).resolves.toEqual([true, true])
  await expect(openNativeChatSideChat(source)).resolves.toBe(true)
  expect(mocks.begin).toHaveBeenCalledTimes(2)
})

it('keeps distinct side questions independent while both launches are pending', async () => {
  const settlement = Promise.withResolvers<{ kind: 'structured' }>()
  mocks.begin.mockReturnValue({ settlement: settlement.promise })
  const first = openNativeChatSideChat(source, 'Question one')
  const second = openNativeChatSideChat(source, 'Question two')
  try {
    await vi.waitFor(() => expect(mocks.begin).toHaveBeenCalledTimes(2))
  } finally {
    settlement.resolve({ kind: 'structured' })
  }
  await expect(Promise.all([first, second])).resolves.toEqual([true, true])
})

it('keeps same-text side questions with different picked skill files independent', async () => {
  const settlement = Promise.withResolvers<{ kind: 'structured' }>()
  mocks.begin.mockReturnValue({ settlement: settlement.promise })
  const one = [{ name: 'review', path: '/one/SKILL.md' }]
  const two = [{ name: 'review', path: '/two/SKILL.md' }]
  const first = openNativeChatSideChat(source, 'use $review', one)
  const second = openNativeChatSideChat(source, 'use $review', two)
  try {
    await vi.waitFor(() => expect(mocks.begin).toHaveBeenCalledTimes(2))
    expect(mocks.begin).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        plan: expect.objectContaining({ skills: one })
      })
    )
    expect(mocks.begin).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        plan: expect.objectContaining({ skills: two })
      })
    )
  } finally {
    settlement.resolve({ kind: 'structured' })
    await Promise.all([first, second])
  }
})

it('keeps read-only and inherited opens independent and carries only the explicit permission override', async () => {
  const settlement = Promise.withResolvers<{ kind: 'structured' }>()
  mocks.begin.mockReturnValue({ settlement: settlement.promise })
  const readOnly = openNativeChatSideChat(source, '', [], 'read-only')
  const inherited = openNativeChatSideChat(source)
  try {
    await vi.waitFor(() => expect(mocks.begin).toHaveBeenCalledTimes(2))
    const plans = mocks.begin.mock.calls.map(([args]) => args.plan)
    expect(plans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ launchOptions: { permissionMode: 'read-only' } }),
        expect.not.objectContaining({ launchOptions: expect.anything() })
      ])
    )
  } finally {
    settlement.resolve({ kind: 'structured' })
  }
  await expect(Promise.all([readOnly, inherited])).resolves.toEqual([true, true])
})
