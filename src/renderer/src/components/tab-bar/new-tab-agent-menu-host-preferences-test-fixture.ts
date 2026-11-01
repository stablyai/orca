import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, expect, vi, type Mock } from 'vitest'
import { useAppStore } from '@/store'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { clearRuntimeCompatibilityCache } from '@/runtime/runtime-compatibility-cache'
import { getDefaultSettings } from '../../../../shared/constants'
import { measureSettingsWork } from '../../../../shared/global-settings-test-fixture'
import * as profile from '../../../../shared/tui-agent-launch-defaults'
import { projectAgentLaunchSettings } from '../../../../shared/agent-launch-settings'
import type { RuntimeEnvironmentStatus } from '../../../../shared/runtime-host-status'
import {
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY as CHAT,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY as CLIENT
} from '../../../../shared/protocol-version'
import {
  makeFolderWorkspace,
  makeWorktree,
  TEST_REPO
} from '@/store/slices/worktrees-slice-test-fixtures'
import { clearHostAgentMenuSettingsForTests } from '../settings/use-host-agent-launch-preferences'

const rpc: { call: Mock; supports: Mock } = vi.hoisted(() => ({
  call: vi.fn(),
  supports: vi.fn()
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: rpc.call,
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
export const payloadWork = { entries: 0, bytes: 0, count: 0 }
export const compositions = vi.spyOn(profile, 'composeAgentLaunchProfile')
export function payload(source: Parameters<typeof projectAgentLaunchSettings>[0] = raw) {
  const before = compositions.mock.calls.length,
    { value: settings, work } = measureSettingsWork(() => projectAgentLaunchSettings(source))
  expect(compositions.mock.calls.length - before).toBe(1)
  const result = { settings },
    text = JSON.stringify(result)
  expect(text).not.toContain('private')
  payloadWork.count++
  payloadWork.entries += work.entries + work.visits + 14 * 20
  payloadWork.bytes += text.length + work.bytes
  return result
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
  Object.assign(payloadWork, { entries: 0, bytes: 0, count: 0 })
  rpc.call.mockReset().mockImplementation(() => payload())
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
