import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { getDefaultSettings } from '../../../shared/constants'
import { useAppStore } from '@/store'
import {
  emptyWorkspaceDefaultChatAwaitsDetection,
  loadEmptyWorkspaceDefaultChatDetection,
  openDefaultAgentChatInEmptyWorkspace
} from './empty-workspace-default-agent-chat'

const mocks = vi.hoisted(() => ({
  launchAgentInNewTab: vi.fn(),
  planAgentSessionLaunch: vi.fn(),
  detectionTargetKey: vi.fn<() => string | undefined>()
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
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: true,
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
    surface: { kind: 'local-agent-session', tabId: 'chat-tab', sessionId: 's-1' }
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  useAppStore.setState(initialAppStoreState, true)
})

describe('openDefaultAgentChatInEmptyWorkspace', () => {
  it('launches the default agent as a chat', () => {
    seedSettings({})

    expect(openDefaultAgentChatInEmptyWorkspace('wt-1')).toEqual({ primaryTabId: 'chat-tab' })
    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'codex', worktreeId: 'wt-1', pendingActivationSpawn: true })
    )
  })

  it('does nothing unless new agent tabs open as chat', () => {
    seedSettings({ openAgentTabsInChatByDefault: false })

    expect(openDefaultAgentChatInEmptyWorkspace('wt-1')).toBeNull()
    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
  })

  it('respects a Blank Terminal default agent', () => {
    seedSettings({ defaultTuiAgent: 'blank' })

    expect(openDefaultAgentChatInEmptyWorkspace('wt-1')).toBeNull()
    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
  })

  it('does not start an agent that could only open as a terminal here', () => {
    seedSettings({})
    mocks.planAgentSessionLaunch.mockReturnValue({ route: 'terminal-tui' })

    expect(openDefaultAgentChatInEmptyWorkspace('wt-1')).toBeNull()
    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
  })

  it('reads the agents detected on the workspace SSH host', () => {
    seedSettings({})
    mocks.detectionTargetKey.mockReturnValue('ssh:conn-1')
    useAppStore.setState({ remoteDetectedAgentIds: { 'conn-1': ['claude'] } })

    openDefaultAgentChatInEmptyWorkspace('wt-1')

    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'claude' })
    )
  })

  it('treats a workspace whose host is unresolved as unknown', () => {
    seedSettings({})
    mocks.detectionTargetKey.mockReturnValue(undefined)

    expect(emptyWorkspaceDefaultChatAwaitsDetection('wt-1')).toBe(false)
    expect(openDefaultAgentChatInEmptyWorkspace('wt-1')).toBeNull()
    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
  })
})

describe('agent detection for the default chat', () => {
  it('waits only while chat is the default and the host list has not loaded', () => {
    seedSettings({})
    mocks.detectionTargetKey.mockReturnValue('ssh:conn-1')
    useAppStore.setState({ remoteDetectedAgentIds: {} })
    expect(emptyWorkspaceDefaultChatAwaitsDetection('wt-1')).toBe(true)

    useAppStore.setState({ remoteDetectedAgentIds: { 'conn-1': [] } })
    expect(emptyWorkspaceDefaultChatAwaitsDetection('wt-1')).toBe(false)

    seedSettings({ openAgentTabsInChatByDefault: false })
    useAppStore.setState({ remoteDetectedAgentIds: {} })
    expect(emptyWorkspaceDefaultChatAwaitsDetection('wt-1')).toBe(false)
  })

  // Why: Blank Terminal opens a shell whatever the host has, so waiting only delays that shell.
  it('does not wait when the default agent is Blank Terminal', () => {
    seedSettings({ defaultTuiAgent: 'blank' })
    mocks.detectionTargetKey.mockReturnValue('ssh:conn-1')
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
