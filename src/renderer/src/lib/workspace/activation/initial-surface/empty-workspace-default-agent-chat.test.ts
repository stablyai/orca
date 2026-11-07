import { EVERY_AGENT_CHAT } from '../../../../../../shared/native-chat/every-agent-chat.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { useAppStore } from '@/store/index'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { loadEmptyWorkspaceDefaultChatDetection } from './empty-workspace-default-agent-chat'

const mocks = vi.hoisted(() => ({
  launchAgentInNewTab: vi.fn(),
  planAgentSessionLaunch: vi.fn(),
  detectionTargetKey: vi.fn<() => string | undefined>(),
  seedShell: vi.fn(() => true)
}))

vi.mock('@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: mocks.launchAgentInNewTab
}))
vi.mock('@/lib/agent-session/launch/routing/agent-session-launch-plan', () => ({
  planAgentSessionLaunch: mocks.planAgentSessionLaunch
}))
vi.mock('@/hooks/useAgentDetectionTarget', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAgentDetectionTargetKeyForWorktree: mocks.detectionTargetKey
}))

const initialAppStoreState = useAppStore.getState()

function seedSettings(settings: Partial<GlobalSettings>): void {
  useAppStore.setState({
    detectedAgentIds: ['claude', 'codex'],
    settings: {
      ...getDefaultSettings('/tmp'),
      nativeChatProviders: EVERY_AGENT_CHAT,
      defaultTuiAgent: 'codex',
      disabledTuiAgents: [],
      ...settings
    }
  })
}

beforeEach(() => {
  mocks.detectionTargetKey.mockReturnValue('local')
  mocks.planAgentSessionLaunch.mockReturnValue({ route: 'structured-native-chat' })
  mocks.launchAgentInNewTab.mockReturnValue({
    surface: { kind: 'host-published' }
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  setLocalRuntimeCapabilitiesForTests(null)
  useAppStore.setState(initialAppStoreState, true)
})

describe('agent detection for the default chat', () => {
  it('probes the workspace host and gives up after a bounded wait', async () => {
    vi.useFakeTimers()
    seedSettings({})
    mocks.detectionTargetKey.mockReturnValue('ssh:conn-1')
    const ensureRemoteDetectedAgents = vi.fn(() => new Promise<never>(() => {}))
    useAppStore.setState({ ensureRemoteDetectedAgents })
    let settled = false

    void loadEmptyWorkspaceDefaultChatDetection('wt-1').then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    expect(ensureRemoteDetectedAgents).toHaveBeenCalledWith('conn-1')
    expect(settled).toBe(true)
  })
})
