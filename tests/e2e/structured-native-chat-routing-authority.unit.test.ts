import { EVERY_AGENT_CHAT } from '../../src/shared/native-chat/every-agent-chat.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as SharedLaunchRoute from '../../src/shared/structured-native-chat-launch-route'
import { decideWorkerStartMode } from '../../src/main/runtime/rpc/methods/orchestration-worker-start-mode'
import { resolveStructuredNativeChatSupport } from '../../src/shared/structured-native-chat-launch-route'

vi.mock('../../src/shared/structured-native-chat-launch-route', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedLaunchRoute>()
  return {
    ...actual,
    resolveStructuredNativeChatSupport: vi.fn(actual.resolveStructuredNativeChatSupport)
  }
})

const settings = {
  nativeChatProviders: EVERY_AGENT_CHAT,
  experimentalStructuredNativeChat: true,
  openAgentTabsInChatByDefault: true
}
const predicate = vi.mocked(resolveStructuredNativeChatSupport)
afterEach(() => predicate.mockReset())

const placements = [
  {},
  { on: 'server-1' },
  { on: 'local' },
  { terminal: 'term_1' },
  { worktree: 'current' },
  { worktree: 'new-child' },
  { worktree: 'new-top-level' },
  { model: 'opus', effort: 'high' },
  { worktree: 'new-child', model: 'opus', effort: 'high' }
]
describe('shared feasibility owns every caller decision', () => {
  // Federated workers start terminal-only on another runtime, so this host must not decide native feasibility for them.
  it.each(placements.filter((placement) => 'on' in placement))(
    'places a worker on another runtime as a terminal agent for %j',
    (placement) => {
      predicate.mockReturnValue({ supported: true })
      const receipt = decideWorkerStartMode({ params: { agent: 'claude', ...placement }, settings })
      expect(receipt).toMatchObject({
        mode: 'terminal',
        preferred: 'structured',
        reason: 'remote_execution_host'
      })
      expect(predicate).not.toHaveBeenCalled()
    }
  )
})
