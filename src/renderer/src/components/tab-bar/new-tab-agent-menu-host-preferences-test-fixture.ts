import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi, type Mock } from 'vitest'
import { useAppStore } from '@/store'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { clearRuntimeCompatibilityCache } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import { getDefaultSettings } from '../../../../shared/constants'
import { projectAgentLaunchSettings } from '../../../../shared/agent-launch/choices/agent-launch-settings'
import type { RuntimeEnvironmentStatus } from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import {
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY as CHAT,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY as CLIENT
} from '../../../../shared/agent-session/agent-session-runtime-capabilities'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { clearHostAgentMenuSettingsForTests } from '../../runtime/agent-launch-settings/host-agent-launch-preferences-resource'

const rpc: { call: Mock; supports: Mock } = vi.hoisted(() => ({
  call: vi.fn(),
  supports: vi.fn()
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: rpc.call
}))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: rpc.supports
}))
vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({ detectedIds: ['claude', 'codex', 'opencode'] })
}))
const initial = useAppStore.getState()
export const server = projectAgentLaunchSettings({
  defaultTuiAgent: 'codex',
  disabledTuiAgents: ['opencode'],
  agentLaunchChoices: { codex: { model: 'host-model', options: { effort: 'low' } } }
})
export const raw = {
  ...server,
  agentLaunchChoices: server.agentChoices?.defaults,
  agentPermissionDefault: 'ask' as const,
  agentDefaultEnv: {
    claude: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`K${i}`, 'private']))
  }
}
function payload(source: Parameters<typeof projectAgentLaunchSettings>[0] = raw) {
  return { settings: projectAgentLaunchSettings(source) }
}

export function status(runtimeId = 'runtime-1'): RuntimeEnvironmentStatus {
  return {
    status: {
      runtimeId,
      capabilities: [CHAT, CLIENT],
      rendererGraphEpoch: 0,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0
    },
    checkedAt: 1
  }
}
beforeEach(() => {
  clearRuntimeCompatibilityCache()
  rpc.call
    .mockReset()
    .mockImplementation((_target, method) =>
      method === 'settings.get' ? { settings: raw } : payload()
    )
  rpc.supports.mockReset().mockResolvedValue(true)
  replaceRuntimeEnvironmentRevisions([{ id: 'alpha', createdAt: 7 }])
  setLocalRuntimeCapabilitiesForTests([CHAT, CLIENT])
  useAppStore.setState({
    ...initial,
    settings: {
      ...getDefaultSettings('/home/me'),
      defaultTuiAgent: 'opencode',
      disabledTuiAgents: ['codex'],
      nativeChatProviders: {}
    },
    runtimeStatusByEnvironmentId: new Map([
      ['alpha', status()],
      ['beta', status('runtime-2')]
    ]),
    repos: [TEST_REPO],
    worktreesByRepo: {
      [TEST_REPO.id]: [makeWorktree({ id: 'wt', repoId: TEST_REPO.id, hostId: 'runtime:alpha' })]
    },
    folderWorkspaces: [makeFolderWorkspace({ id: 'f1', executionHostId: 'runtime:alpha' })]
  })
})
afterEach(() => {
  cleanup()
  clearHostAgentMenuSettingsForTests()
  clearRuntimeCompatibilityCache()
  useAppStore.setState(initial, true)
  setLocalRuntimeCapabilitiesForTests(null)
  replaceRuntimeEnvironmentRevisions([])
})

export { rpc }
