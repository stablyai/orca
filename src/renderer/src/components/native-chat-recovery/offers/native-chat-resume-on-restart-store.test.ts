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
    target: { kind: 'local' as const },
    readNativeChatRestartOffer: async () => ({ available: true, candidates, failed: [] }),
    continueNativeChatRestartOffer: continued
  }
  return { store, continued }
}

afterEach(() => {
  consumeNativeChatResumeOnRestartDialogRequest()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

const olderHost = async () => 'unsupported' as const
const hostContinued = async () => 'settled' as const

describe('launch auto-resume', () => {
  it('leaves continuing to a host that does it, and asks the person about what it left', async () => {
    const { store, continued } = launchWith([
      candidate('question', {
        state: 'blocked',
        prompts: [{ kind: 'question', label: 'Which branch?' }],
        tasks: []
      })
    ])

    await loadNativeChatLaunchOffer(store, hostContinued)

    expect(continued).not.toHaveBeenCalled()
    expect(getNativeChatResumeOnRestartDialogRequest()).toBe(true)
  })

  it('on an older host, resumes working chats and asks the person about chats waiting on them', async () => {
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

    await loadNativeChatLaunchOffer(store, olderHost)

    expect(continued).toHaveBeenCalledWith(['working', 'older-host'], 'launch')
    expect(getNativeChatResumeOnRestartDialogRequest()).toBe(true)
  })

  it('on an older host, opens nothing when every offered chat was working', async () => {
    const { store, continued } = launchWith([
      candidate('working', { state: 'working', prompts: [], tasks: [] })
    ])

    await loadNativeChatLaunchOffer(store, olderHost)

    expect(continued).toHaveBeenCalledWith(['working'], 'launch')
    expect(getNativeChatResumeOnRestartDialogRequest()).toBe(false)
  })
})
