// Permission bypass lives only in the arguments string; verify each caller’s final argv so it cannot be silently lost.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../../shared/tui-agent'

import {
  createLaunchFunnelStore,
  queuedStartupCommand,
  queuedStartupPayload,
  resetLaunchFunnelStore
} from './agent-launch-funnel-test-harness'

const store = createLaunchFunnelStore()

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'darwin' }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdFromState: () => null }))
vi.mock('../../../shared/native-chat/transcript/native-chat-transcript-readability', () => ({
  isNativeChatTranscriptLocalReadable: () => true
}))
vi.mock('@/runtime/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: () => false
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => 'local',
  runtimeEnvironmentIdOrLocalUnlessTwin: () => null
}))
vi.mock('@/components/tab-bar/reconcile-order', () => ({
  reconcileTabOrder: (_stored: unknown, terminalIds: string[]) => terminalIds
}))
vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))
vi.mock('@/components/native-chat/native-chat-session-option-cache', () => ({
  seedNativeChatAppliedSessionOptions: vi.fn()
}))
vi.mock('@/lib/agent-paste-draft', () => ({ pasteDraftWhenAgentReady: vi.fn(async () => true) }))
vi.mock('@/lib/agent-ready-wait', () => ({
  waitForAgentReady: vi.fn(async () => ({ ready: true, reason: 'foreground-match' }))
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: () => []
}))
// A launch the host delivers waits on its reply; these tests read only what was sent.
const callRuntimeRpc = vi.hoisted(() => vi.fn(() => new Promise(() => {})))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc }))
vi.mock('@/runtime/runtime-rpc-result', () => ({ RuntimeRpcCallError: Error }))

const CODEX_BYPASS = '--dangerously-bypass-approvals-and-sandbox'

/** One agent per prompt-injection mode, with the bypass flag Orca ships as that agent's default. */
const BYPASS_BY_AGENT: readonly [TuiAgent, string, string][] = [
  ['codex', 'argv', CODEX_BYPASS],
  ['claude', 'argv', '--dangerously-skip-permissions'],
  ['gemini', 'flag-prompt-interactive', '--yolo'],
  ['copilot', 'flag-interactive', '--yolo'],
  ['hermes', 'hermes-query', '--yolo'],
  ['amp', 'stdin-after-start', '--dangerously-allow-all']
]

describe('agent launch caller arguments and permission bypass', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetLaunchFunnelStore(store)
  })

  it.each(BYPASS_BY_AGENT)(
    'ships %s (%s) with its permission-bypass flag when no call site names arguments',
    async (agent, _mode, bypassFlag) => {
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

      launchAgentInNewTab({ requestId: 'request-2', agent, worktreeId: 'wt-1' })

      expect(queuedStartupCommand(store)).toContain(bypassFlag)
    }
  )

  it.each(BYPASS_BY_AGENT)(
    'drops the bypass flag for %s when the user stored Manual arguments',
    async (agent, _mode, bypassFlag) => {
      store.settings = { ...store.settings, agentDefaultArgs: { [agent]: '' } }
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

      launchAgentInNewTab({ requestId: 'request-3', agent, worktreeId: 'wt-1' })

      // A stored empty string owns the key, so it beats the shipped bypass default.
      expect(queuedStartupCommand(store)).not.toContain(bypassFlag)
    }
  )

  it('launches without any arguments when a caller passes agentArgs as null', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      requestId: 'request-6',
      agent: 'codex',
      worktreeId: 'wt-1',
      agentArgs: null
    })

    expect(queuedStartupCommand(store)).toBe("codex '-c' 'disable_paste_burst=true'")
    expect(queuedStartupPayload(store)?.agentArgsOverride).toBeNull()
  })

  it('lets a per-launch argument beat the stored setting', async () => {
    store.settings = { ...store.settings, agentDefaultArgs: { codex: '--model stored' } }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      requestId: 'request-7',
      agent: 'codex',
      worktreeId: 'wt-1',
      agentArgs: '--model per-launch'
    })

    expect(queuedStartupCommand(store)).toBe(
      "codex '-c' 'disable_paste_burst=true' '--model' 'per-launch'"
    )
  })

  // Composer picks seed structured creates only; terminal fallbacks must not receive them (launch-structured-agent-session tests).
  it.each([
    [true, undefined, CODEX_BYPASS],
    [false, undefined, CODEX_BYPASS],
    [true, '--search', '--search'],
    [false, '--search', '--search']
  ])(
    'keeps remembered model and effort off a terminal fallback (Chat UI %s, stored args %s)',
    async (chatUi, storedArgs, expectedArgs) => {
      store.settings = {
        ...store.settings,
        nativeChatProviders: { codex: chatUi },
        ...(storedArgs === undefined ? {} : { agentDefaultArgs: { codex: storedArgs } }),
        nativeChatSessionOptions: {
          codex: {
            model: 'gpt-5.2-codex',
            valuesByModel: { 'gpt-5.2-codex': { effort: 'medium' } }
          }
        }
      }
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

      const result = launchAgentInNewTab({
        requestId: 'request-9',
        agent: 'codex',
        worktreeId: 'wt-1'
      })

      expect(result?.startupPlan?.sessionOptions).toBeUndefined()
      const command = queuedStartupCommand(store)
      expect(command).not.toContain("'-m'")
      expect(command).not.toContain('model_reasoning_effort')
      expect(command).toBe(`codex '-c' 'disable_paste_burst=true' '${expectedArgs}'`)
    }
  )
})
