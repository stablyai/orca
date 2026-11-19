// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../../store/index'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import type { ResumeCandidate } from '../tree/native-chat-resume-on-restart-grouping'
import {
  consumeNativeChatResumeOnRestartDialogRequest,
  getNativeChatResumeOnRestartDialogRequest
} from '../dialogs/native-chat-resume-on-restart-dialog'
import { loadNativeChatLaunchOffer } from './native-chat-resume-on-restart-store'

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
    readNativeChatRestartOffer: async () => ({ available: true, candidates, failed: [] }),
    continueNativeChatRestartOffer: continued
  }
  return { store, continued }
}

afterEach(() => {
  consumeNativeChatResumeOnRestartDialogRequest()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('launch auto-resume', () => {
  it('resumes only working chats and opens the report toast', async () => {
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

    await loadNativeChatLaunchOffer(store)

    expect(continued).toHaveBeenCalledWith(['working', 'older-host'], 'launch')
    expect(getNativeChatResumeOnRestartDialogRequest()).toBe(true)
  })

  it('offers a Resume without sending anything when the preference is off', async () => {
    const { store, continued } = launchWith([
      candidate('working', { state: 'working', prompts: [], tasks: [] })
    ])
    useAppStore.setState({
      settings: { ...getDefaultSettings(''), nativeChatResumeWorkOnRestart: false }
    })

    await loadNativeChatLaunchOffer(store)

    expect(continued).not.toHaveBeenCalled()
    expect(getNativeChatResumeOnRestartDialogRequest()).toBe(true)
  })
})
