// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { useAppStore } from '../../../store/index'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import type { ResumeCandidate } from '../tree/native-chat-resume-on-restart-grouping'
import {
  consumeNativeChatResumeOnRestartDialogRequest,
  getNativeChatResumeOnRestartDialogRequest
} from '../dialogs/native-chat-resume-on-restart-dialog'
import { loadNativeChatLaunchOffer } from './native-chat-resume-on-restart-store'

vi.mock('@/runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: vi.fn()
}))

const call = vi.mocked(callStructuredAgentSession)

function failLaunchRead(code: string): void {
  call.mockRejectedValueOnce(
    new RuntimeRpcCallError({ id: '1', ok: false, error: { code, message: code } })
  )
}

function candidate(sessionId: string, activity?: ResumeCandidate['activity']): ResumeCandidate {
  return {
    sessionId,
    workspaceId: 'repo::/repo',
    agent: 'codex',
    trigger: 'quit',
    latestPrompt: 'fix the build',
    recordedAt: 1,
    ...(activity ? { activity } : {})
  }
}

function launchWith(candidates: ResumeCandidate[]) {
  useAppStore.setState({
    settings: { ...getDefaultSettings(''), nativeChatResumeWorkOnRestart: true }
  })
  const continued = vi.fn(async () => {})
  const store = {
    target: { kind: 'local' as const },
    readNativeChatRestartOffer: async () => ({ available: true, candidates, failed: [] }),
    continueNativeChatRestartOffer: continued
  }
  return { store, continued }
}

afterEach(() => {
  call.mockReset()
  consumeNativeChatResumeOnRestartDialogRequest()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('launch auto-resume', () => {
  it('leaves continuing to the host when its launch read times out', async () => {
    const { store, continued } = launchWith([
      candidate('working', { state: 'working', prompts: [], tasks: [] })
    ])
    failLaunchRead('runtime_timeout')

    await loadNativeChatLaunchOffer(store)

    expect(continued).not.toHaveBeenCalled()
    expect(getNativeChatResumeOnRestartDialogRequest()).toBe(true)
  })

  it("reports the host's own run in the toast, though it left nothing to ask about", async () => {
    const { store, continued } = launchWith([])
    const took = [candidate('working', { state: 'working', prompts: [], tasks: [] })]

    await loadNativeChatLaunchOffer(store, async () => took)

    expect(continued).toHaveBeenCalledWith(['working'], 'launch', took)
    expect(getNativeChatResumeOnRestartDialogRequest()).toBe(true)
  })

  it('on an older host, resumes only working chats and opens the report toast', async () => {
    const { store, continued } = launchWith([
      candidate('working', { state: 'working', prompts: [], tasks: [] }),
      candidate('approval', {
        state: 'blocked',
        prompts: [{ kind: 'approval', label: 'Run a command?' }],
        tasks: [{ kind: 'agent', label: 'explorer' }]
      }),
      candidate('question', {
        state: 'blocked',
        prompts: [{ kind: 'question', label: 'Which branch?' }],
        tasks: []
      }),
      candidate('older-host')
    ])
    failLaunchRead('method_not_found')

    await loadNativeChatLaunchOffer(store)

    expect(continued).toHaveBeenCalledWith(['working', 'older-host'], 'launch')
    expect(getNativeChatResumeOnRestartDialogRequest()).toBe(true)
  })

  it('on an older host, offers a Resume without sending anything when the preference is off', async () => {
    const { store, continued } = launchWith([
      candidate('working', { state: 'working', prompts: [], tasks: [] })
    ])
    useAppStore.setState({
      settings: { ...getDefaultSettings(''), nativeChatResumeWorkOnRestart: false }
    })
    failLaunchRead('method_not_found')

    await loadNativeChatLaunchOffer(store)

    expect(continued).not.toHaveBeenCalled()
    expect(getNativeChatResumeOnRestartDialogRequest()).toBe(true)
  })
})
