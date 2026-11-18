// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import { useAppStore } from '../../../store/index'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import type { ResumeCandidate } from '../tree/native-chat-resume-on-restart-grouping'
import {
  consumeNativeChatResumeOnRestartDialogRequest,
  getNativeChatResumeOnRestartDialogRequest
} from '../dialogs/native-chat-resume-on-restart-dialog'
import {
  _resetNativeChatRestartOffer,
  getNativeChatRestartResuming,
  getNativeChatRestartRun,
  loadNativeChatLaunchOffer,
  localNativeChatRestartStore
} from './native-chat-resume-on-restart-store'

vi.mock('@/runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: vi.fn()
}))
vi.mock('../runs/native-chat-resume-run-status-watch', () => ({
  watchResumeRunStatus: () => () => {}
}))
vi.mock('sonner', async () =>
  (await import('../integration/native-chat-resume-sonner-mock.test-support')).resumeSonnerMock()
)

const row = (sessionId: string, activity?: ResumeCandidate['activity']): ResumeCandidate => ({
  sessionId,
  workspaceId: 'repo::/repo',
  agent: 'claude',
  trigger: 'crash',
  latestPrompt: `Prompt ${sessionId}`,
  recordedAt: 1,
  ...(activity ? { activity } : {})
})

afterEach(() => {
  consumeNativeChatResumeOnRestartDialogRequest()
  _resetNativeChatRestartOffer()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('a host that continues at launch', () => {
  it('shows what it took as this launch run, then offers what it left', async () => {
    useAppStore.setState({
      settings: { ...getDefaultSettings(''), nativeChatResumeWorkOnRestart: true }
    })
    const asking = row('asking', {
      state: 'blocked',
      prompts: [{ kind: 'question', label: 'Which branch?' }],
      tasks: []
    })
    const settled = Promise.withResolvers<unknown>()
    vi.mocked(callStructuredAgentSession).mockImplementation(async (_target, method, params) => {
      if (method === 'agentSession.restartLaunchSettled') {
        return (params as { until?: string } | undefined)?.until === 'taken'
          ? { sessions: [row('working')] }
          : settled.promise
      }
      if (method === 'agentSession.restartResumable') {
        return { sessions: [asking], failed: [] }
      }
      throw new Error(`unexpected ${method}`)
    })

    const launch = loadNativeChatLaunchOffer(localNativeChatRestartStore)
    await vi.waitFor(() => expect(getNativeChatRestartRun()?.inFlight).toBe(true))

    expect(getNativeChatRestartRun()).toMatchObject({
      startedBy: 'launch',
      entries: [{ candidate: { sessionId: 'working' } }]
    })
    expect(getNativeChatRestartResuming()).toEqual(['working'])
    expect(vi.mocked(callStructuredAgentSession).mock.calls.map((call) => call[1])).not.toContain(
      'agentSession.restartContinue'
    )

    settled.resolve({
      continuedSessionIds: ['working'],
      continued: [{ sessionId: 'working', outcome: 'continued' }],
      sessions: [asking],
      failed: []
    })
    await launch

    expect(getNativeChatRestartRun()).toMatchObject({
      inFlight: false,
      continued: [{ sessionId: 'working', outcome: 'continued' }]
    })
    expect(getNativeChatRestartResuming()).toEqual([])
    expect(getNativeChatResumeOnRestartDialogRequest()).toBe(true)
  })
})
