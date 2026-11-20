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
  loadNativeChatLaunchOffer,
  localNativeChatRestartStore
} from './native-chat-resume-on-restart-store'

vi.mock('@/runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: vi.fn()
}))

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
  it('follows what it took without reporting progress, then offers what it left', async () => {
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
        return params && typeof params === 'object' && 'until' in params && params.until === 'taken'
          ? { sessions: [row('working')] }
          : settled.promise
      }
      if (method === 'agentSession.restartResumable') {
        return { sessions: [asking], failed: [] }
      }
      throw new Error(`unexpected ${method}`)
    })

    const launch = loadNativeChatLaunchOffer(localNativeChatRestartStore)
    await vi.waitFor(() => expect(getNativeChatRestartResuming()).toEqual(['working']))

    expect(getNativeChatResumeOnRestartDialogRequest()).toBe(false)
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

    expect(getNativeChatRestartResuming()).toEqual([])
    expect(getNativeChatResumeOnRestartDialogRequest()).toBe(true)
  })
})
