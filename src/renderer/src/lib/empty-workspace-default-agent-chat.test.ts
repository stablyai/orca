import { EVERY_AGENT_CHAT } from '../../../shared/native-chat/every-agent-chat.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { getDefaultSettings } from '../../../shared/constants'
import { useAppStore } from '@/store'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import {
  emptyWorkspaceDefaultChatAwaitsDetection,
  loadEmptyWorkspaceDefaultChatDetection,
  openDefaultAgentChatInEmptyWorkspace
} from './empty-workspace-default-agent-chat'

const mocks = vi.hoisted(() => ({
  launchAgentInNewTab: vi.fn(),
  planAgentSessionLaunch: vi.fn(),
  detectionTargetKey: vi.fn<() => string | undefined>(),
  seedShell: vi.fn(() => true)
}))

vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: mocks.launchAgentInNewTab
}))
vi.mock('@/lib/agent-session-launch-plan', () => ({
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

describe('openDefaultAgentChatInEmptyWorkspace', () => {
  it("seeds a plain shell, not the agent's terminal, when the host declines the chat", () => {
    seedSettings({})

    openDefaultAgentChatInEmptyWorkspace('wt-1', mocks.seedShell)
    const onDeclined = mocks.launchAgentInNewTab.mock.calls[0]?.[0]?.onStructuredHostDeclined

    expect(mocks.seedShell).not.toHaveBeenCalled()
    expect(onDeclined()).toEqual({ opened: true })
    expect(mocks.seedShell).toHaveBeenCalledOnce()
  })

  it('reads the agents detected on the workspace SSH host', () => {
    seedSettings({})
    mocks.detectionTargetKey.mockReturnValue('ssh:conn-1')
    useAppStore.setState({ remoteDetectedAgentIds: { 'conn-1': ['claude'] } })

    openDefaultAgentChatInEmptyWorkspace('wt-1', mocks.seedShell)

    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'claude' })
    )
  })
})

describe('agent detection for the default chat', () => {
  it('waits only while chat is the default and the host list has not loaded', () => {
    seedSettings({})
    setLocalRuntimeCapabilitiesForTests([])
    mocks.detectionTargetKey.mockReturnValue('ssh:conn-1')
    useAppStore.setState({ remoteDetectedAgentIds: {} })
    expect(emptyWorkspaceDefaultChatAwaitsDetection('wt-1')).toBe(true)

    useAppStore.setState({ remoteDetectedAgentIds: { 'conn-1': [] } })
    expect(emptyWorkspaceDefaultChatAwaitsDetection('wt-1')).toBe(false)

    seedSettings({ nativeChatProviders: {} })
    useAppStore.setState({ remoteDetectedAgentIds: {} })
    expect(emptyWorkspaceDefaultChatAwaitsDetection('wt-1')).toBe(false)
  })

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
