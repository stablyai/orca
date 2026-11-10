import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createLaunchFunnelStore, resetLaunchFunnelStore } from './agent-launch-funnel-test-harness'
import type * as LaunchConnectionOwnerModule from '../../../workspace/ownership/connection-owner-resolution'
import type * as LaunchAgentKindModule from '../../../../../../shared/agent-kind'

const store = createLaunchFunnelStore()
/** Loosely typed so the suite can read back the whole delivery request the funnel built. */
const mockPasteDraftWhenAgentReady = vi.fn<(request: Record<string, unknown>) => Promise<boolean>>(
  async () => true
)

vi.mock('@/store/index', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/workspace/creation/new-workspace', () => ({ CLIENT_PLATFORM: 'darwin' }))
vi.mock('@/lib/workspace/ownership/connection-context', () => ({
  getConnectionIdFromState: mockLaunchConnectionId
}))
const mockLaunchConnectionId = vi.hoisted(() => () => null)
vi.mock('../../../workspace/ownership/connection-owner-resolution', async (importOriginal) => ({
  ...(await importOriginal<typeof LaunchConnectionOwnerModule>()),
  getConnectionIdFromState: mockLaunchConnectionId
}))

vi.mock(
  '../../../../../../shared/native-chat/transcript/native-chat-transcript-readability',
  () => ({
    isNativeChatTranscriptLocalReadable: () => true
  })
)
vi.mock('@/runtime/web-session-tabs-sync/identity/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: () => false
}))
vi.mock('@/lib/workspace/ownership/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => 'local',
  runtimeEnvironmentIdOrLocalUnlessTwin: () => null
}))
vi.mock('@/components/tab-bar/reconcile-order', () => ({
  reconcileTabOrder: (_stored: unknown, terminalIds: string[]) => terminalIds
}))
vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: mockLaunchAgentKind
}))
const mockLaunchAgentKind = vi.hoisted(() => (agent: string) => agent)
vi.mock('../../../../../../shared/agent-kind', async (importOriginal) => ({
  ...(await importOriginal<typeof LaunchAgentKindModule>()),
  tuiAgentToAgentKind: mockLaunchAgentKind
}))

vi.mock('../../../../../../shared/native-chat/input/native-chat-session-option-cache', () => ({
  seedNativeChatAppliedSessionOptions: vi.fn()
}))
vi.mock('@/lib/agent-session/messaging/paste/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mockPasteDraftWhenAgentReady
}))
vi.mock('@/lib/agent-session/messaging/paste/agent-ready-wait', () => ({
  waitForAgentReady: vi.fn(async () => ({ ready: true, reason: 'foreground-match' }))
}))
vi.mock('@/runtime/hosts/capabilities/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: () => []
}))
// The host starts an AI button's agent in the tab's pane and answers; the window then pastes.
const callRuntimeRpc = vi.hoisted(() =>
  vi.fn(async (_target: unknown, _method: string, params: Record<string, unknown>) => ({
    outcome: { kind: 'terminal', handle: 'term_1', paneKey: params.paneKey },
    worktreeId: 'wt-1',
    receipt: { mode: 'terminal', preferred: 'terminal', reason: 'user_default', detail: 'x' }
  }))
)
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-result', () => ({ RuntimeRpcCallError: Error }))

const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
const PROMPT = 'Explain the failing check and propose a fix.'

describe('agent launch caller prompt transport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetLaunchFunnelStore(store)
    mockPasteDraftWhenAgentReady.mockResolvedValue(true)
  })

  it('reports an undelivered submit-after-ready prompt without throwing at the caller', async () => {
    mockPasteDraftWhenAgentReady.mockResolvedValue(false)
    const onPromptDelivered = vi.fn()

    const result = launchAgentInNewTab({
      requestId: 'request-6',
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: PROMPT,
      promptDelivery: 'submit-after-ready',
      onPromptDelivered
    })
    if (result && 'refused' in result) {
      throw new Error('Expected an opened launch')
    }

    await expect(result?.promptDeliveryResult).resolves.toMatchObject({ delivered: false })
    expect(onPromptDelivered).not.toHaveBeenCalled()
  })
})
