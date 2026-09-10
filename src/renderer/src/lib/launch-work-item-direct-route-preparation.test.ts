// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { AppState } from '@/store/types'

vi.mock('@/lib/worktree-runtime-owner', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, getExecutionHostIdForWorktree: () => 'local' }
})

import { resolveAgentLaunchRoute } from '@/lib/agent-launch-routing'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { prepareDirectWorkItemAgentLaunch } from './launch-work-item-direct-route-preparation'

const structuredSettings = {
  experimentalNativeChat: true,
  openAgentTabsInChatByDefault: true,
  experimentalStructuredNativeChat: true
} as GlobalSettings

describe('prepareDirectWorkItemAgentLaunch launch route before hydration', () => {
  afterEach(() => {
    setLocalRuntimeCapabilitiesForTests([])
    Reflect.deleteProperty(window, 'api')
    vi.clearAllMocks()
  })

  it('probes the local runtime instead of degrading to legacy when capabilities are unknown', async () => {
    setLocalRuntimeCapabilitiesForTests(null)
    const getStatus = vi
      .fn()
      .mockResolvedValue({ capabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY] })
    Object.assign(window, { api: { runtime: { getStatus } } })
    const latestStore = {
      ensureDetectedAgents: vi.fn(async () => ['claude']),
      updateWorktreeMeta: vi.fn(async () => {}),
      settings: structuredSettings
    } as unknown as AppState

    const preparation = await prepareDirectWorkItemAgentLaunch({
      worktreeId: 'wt-1',
      worktreePath: '/repo/wt-1',
      agentOverride: 'claude',
      repoConnectionId: null,
      detectedAgentsPromise: null,
      latestStore,
      settings: structuredSettings,
      draftContent: 'fix the failing check',
      promptDelivery: 'submit-after-ready',
      launchPlatform: 'darwin',
      routeResolver: resolveAgentLaunchRoute
    })

    expect(getStatus).toHaveBeenCalled()
    expect(preparation.structuredLaunch).toBe(true)
  })
})
