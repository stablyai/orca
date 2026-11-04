// @vitest-environment happy-dom
import { EVERY_AGENT_CHAT } from '../../../../shared/native-chat/every-agent-chat.test-fixture'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi, type Mock } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY as CHAT } from '../../../../shared/agent-session/agent-session-runtime-capabilities'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import type * as StructuredAgentClient from '@/runtime/structured-agent-session-client'
import type { UseDetectedAgentsResult } from '@/hooks/useDetectedAgents'

const mocks: {
  capability: Mock
  detection: Mock<() => UseDetectedAgentsResult>
  launch: Mock
} = vi.hoisted(() => ({
  capability: vi.fn(),
  detection: vi.fn<() => UseDetectedAgentsResult>(),
  launch: vi.fn()
}))
vi.mock('@/runtime/structured-agent-session-client', async (importOriginal) => ({
  ...(await importOriginal<typeof StructuredAgentClient>()),
  supportsStructuredAgentSessionContinuationContext: mocks.capability
}))
vi.mock('@/hooks/useDetectedAgents', () => ({ useDetectedAgents: mocks.detection }))
vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  useAgentDetectionTargetForWorktree: () => ({ kind: 'local' })
}))
vi.mock('@/lib/launch-agent-session-continuation', () => ({
  launchAgentSessionContinuation: mocks.launch
}))
const initial = useAppStore.getState()
export const request = {
  source: { capturedText: 'previous session', sourceAgent: 'codex' as const },
  worktreeId: 'wt-1',
  workspacePath: '/repo',
  groupId: 'group-1',
  initialCwd: '/repo/.',
  launchSource: 'sidebar' as const
}
export const detection: UseDetectedAgentsResult = {
  detectedIds: ['codex'],
  isLoading: false,
  detectionFailed: false,
  isRefreshing: false,
  needsServerUpdate: false,
  refresh: async () => ['codex']
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.capability.mockResolvedValue(false)
  mocks.detection.mockReturnValue(detection)
  mocks.launch.mockResolvedValue(true)
  setLocalRuntimeCapabilitiesForTests([CHAT])
  useAppStore.setState({
    settings: { ...getDefaultSettings('/test'), nativeChatProviders: EVERY_AGENT_CHAT },
    repos: [{ id: 'repo-1', path: '/repo', displayName: 'repo', badgeColor: '', addedAt: 0 }],
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' })]
    }
  })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
})

export { mocks }
