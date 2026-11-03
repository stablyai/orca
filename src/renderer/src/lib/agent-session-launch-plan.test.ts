import { beforeEach, describe, expect, it, vi } from 'vitest'
import { projectSourceControlActionLaunch } from '../../../shared/source-control-action-launch-preferences'
import type { AgentLaunchRouteStore } from './agent-launch-route-input'

const mocks = vi.hoisted(() => ({
  buildAgentLaunchRouteInput: vi.fn(),
  resolveAgentLaunchRoute: vi.fn(),
  structuredAgentLaunchSupported: vi.fn(),
  beginStructuredAgentLaunchSettlement: vi.fn()
}))

vi.mock('@/lib/agent-launch-route-input', () => ({
  buildAgentLaunchRouteInput: mocks.buildAgentLaunchRouteInput
}))
vi.mock('@/lib/agent-launch-routing', () => ({
  resolveAgentLaunchRoute: mocks.resolveAgentLaunchRoute,
  structuredAgentLaunchSupported: mocks.structuredAgentLaunchSupported,
  structuredAgentLaunchDowngrade: () => null
}))
vi.mock('@/lib/structured-agent-launch-settlement', () => ({
  beginStructuredAgentLaunchSettlement: mocks.beginStructuredAgentLaunchSettlement
}))

import { planAgentSessionLaunch } from './agent-session-launch-plan'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the route builder is mocked, so this store is only forwarded and never read.
const store = { settings: {} } as unknown as AgentLaunchRouteStore
const ROUTE_INPUT = { agent: 'codex', executionHostId: 'local' }
const STRUCTURED = { kind: 'structured', sessionId: 'session-1' }
const hooks = { onStructuredReady: vi.fn() }

describe('planAgentSessionLaunch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.buildAgentLaunchRouteInput.mockReturnValue(ROUTE_INPUT)
    mocks.resolveAgentLaunchRoute.mockReturnValue('structured-native-chat')
    mocks.structuredAgentLaunchSupported.mockReturnValue(true)
    mocks.beginStructuredAgentLaunchSettlement.mockReturnValue({
      sessionId: 'session-1',
      settlement: Promise.resolve(STRUCTURED)
    })
  })

  it.each<Readonly<Record<string, string>> | undefined>([
    undefined,
    {},
    { model: 'true', effort: 'high' }
  ])(
    'captures the owner route views and selects a complete Chat replacement (%j)',
    async (alternative) => {
      const projection = projectSourceControlActionLaunch(
        {
          agentId: 'codex',
          agentArgs: `-c 'model="true"'`,
          launchPreferences: {
            agentId: 'codex',
            modelSelection: {
              base: 'default',
              options: { effort: { agentId: 'codex', value: 'high' } }
            }
          }
        },
        'codex',
        { basePrompt: 'Fix checks' }
      )
      expect(projection.agentArgs).toBe(`-c 'model="true"'`)
      expect(projection.sessionOptions).toEqual({ effort: 'high' })
      expect(projection.chatSessionOptions).toEqual({ model: 'true', effort: 'high' })
      const base = { ...projection.sessionOptions }
      const chat = alternative === undefined ? undefined : { ...alternative }
      const plan = planAgentSessionLaunch(store, {
        requestId: 'route-views',
        agent: 'codex',
        workspace: { kind: 'git-worktree', worktreeId: 'wt-1' },
        launchOptions: base,
        ...(chat !== undefined ? { chatLaunchOptions: chat } : {})
      })
      base.effort = 'low'
      if (chat && 'model' in chat) {
        chat.model = 'later-model'
      }
      expect(plan.launchOptions).toEqual({ effort: 'high' })
      await plan.launch(hooks)
      expect(mocks.beginStructuredAgentLaunchSettlement).toHaveBeenCalledWith(
        'wt-1',
        'codex',
        {
          requestId: 'route-views',
          executionHostId: 'local',
          launchOptions: alternative ?? { effort: 'high' }
        },
        hooks
      )
      const request = mocks.beginStructuredAgentLaunchSettlement.mock.calls[0][2]
      expect(request).not.toHaveProperty('chatLaunchOptions')
      expect(request).not.toHaveProperty('chatSessionOptions')
    }
  )
})
