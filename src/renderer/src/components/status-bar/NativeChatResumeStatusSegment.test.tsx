// @vitest-environment happy-dom

import { EVERY_AGENT_CHAT } from '../../../../shared/native-chat/every-agent-chat.test-fixture'
import { resetLocalStructuredChatsForTests } from '@/runtime/native-chat/local-sessions/local-structured-chats'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '../../store'
import { TooltipProvider } from '../ui/tooltip'
import type { ResumeCandidate } from '../native-chat-recovery/tree/native-chat-resume-on-restart-grouping'
import {
  consumeNativeChatResumeOnRestartDialogRequest,
  getNativeChatResumeOnRestartDialogRequest
} from '../native-chat-recovery/dialogs/native-chat-resume-on-restart-dialog'
import {
  _resetNativeChatRestartOffer,
  localNativeChatRestartStore
} from '../native-chat-recovery/offers/native-chat-resume-on-restart-store'
import { NativeChatResumeStatusSegment } from './NativeChatResumeStatusSegment'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('../../runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: rpc
}))

vi.mock('../../runtime/native-chat/requests/structured-agent-session-subscriptions', () => ({
  // A failed row opens the status feed; these cases never drive it.
  subscribeStructuredAgentSessionStatus: () => new Promise(() => {})
}))

const candidates: ResumeCandidate[] = [
  {
    sessionId: 'a',
    workspaceId: 'workspace',
    agent: 'codex',
    trigger: 'quit',
    latestPrompt: 'Fix it',
    recordedAt: 1
  },
  {
    sessionId: 'b',
    workspaceId: 'workspace',
    agent: 'claude',
    trigger: 'update',
    latestPrompt: 'Review it',
    recordedAt: 2
  }
]

function stageLocalHost(installed: boolean): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      app: {
        holdsStructuredAgentSessions: async () => installed,
        onStructuredAgentSessionsHeldChanged: () => () => undefined
      }
    }
  })
}

async function mount(iconOnly = false): Promise<void> {
  await act(async () => {
    render(
      <TooltipProvider>
        <NativeChatResumeStatusSegment iconOnly={iconOnly} />
      </TooltipProvider>
    )
  })
  act(() => consumeNativeChatResumeOnRestartDialogRequest())
}

describe('NativeChatResumeStatusSegment', () => {
  beforeEach(() => {
    rpc.mockReset()
    _resetNativeChatRestartOffer()
    consumeNativeChatResumeOnRestartDialogRequest()
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      // These cases cover the review flow, which runs while automatic resume is off.
      settings: {
        ...getDefaultSettings(''),
        nativeChatProviders: EVERY_AGENT_CHAT,
        nativeChatResumeWorkOnRestart: false
      }
    })
  })

  afterEach(() => {
    cleanup()
    resetLocalStructuredChatsForTests()
    Reflect.deleteProperty(window, 'api')
    _resetNativeChatRestartOffer()
    consumeNativeChatResumeOnRestartDialogRequest()
    useAppStore.setState(useAppStore.getInitialState(), true)
  })

  // The count can lag the host — another window may have dismissed the offer. The re-read decides.
  it('does not reopen the dialog when the host no longer offers anything', async () => {
    rpc.mockResolvedValueOnce({ sessions: candidates }).mockResolvedValue({ sessions: [] })
    await mount()

    expect(getNativeChatResumeOnRestartDialogRequest()).toBe(false)
    await act(async () => screen.getByRole('button').click())
    expect(getNativeChatResumeOnRestartDialogRequest()).toBe(false)
    expect(screen.queryByRole('button')).toBeNull()
  })

  // The setting picks what new agents open as; chats that already exist keep their offer.
  it('offers to continue the chats this machine holds while the setting is off', async () => {
    rpc.mockResolvedValue({ sessions: candidates })
    useAppStore.setState({
      settings: {
        ...getDefaultSettings(''),
        nativeChatProviders: {},
        nativeChatResumeWorkOnRestart: false
      }
    })
    stageLocalHost(true)
    await mount()

    expect(rpc).toHaveBeenCalledWith(expect.anything(), 'agentSession.restartResumable')
    expect(screen.getByRole('button')).toBeTruthy()
  })

  // The offer is this machine's runtime's; a paired server's chats are no reason to build it.
  it("does not ask this machine for an offer over a paired server's chats", async () => {
    rpc.mockResolvedValue({ sessions: candidates })
    useAppStore.setState({
      settings: { ...getDefaultSettings(''), nativeChatProviders: {} },
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'agent-session:claude_1',
            entityId: 'claude_1',
            groupId: 'group-1',
            worktreeId: 'wt-1',
            executionHostId: 'runtime:server-1',
            contentType: 'agent-session',
            agentSessionAgent: 'claude',
            label: 'Claude Chat',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    })
    stageLocalHost(false)
    await mount()

    expect(rpc).not.toHaveBeenCalled()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('keeps run-only uncertainty reachable until its viewed summary is closed', async () => {
    rpc.mockResolvedValue({ sessions: [candidates[0]], failed: [] })
    await mount()
    rpc.mockImplementation(async (_target, method) => {
      if (method === 'agentSession.restartContinue') {
        throw new Error('accepted reply lost')
      }
      return { sessions: [], failed: [] }
    })
    await act(async () => localNativeChatRestartStore.continueNativeChatRestartOffer(['a']))
    const entry = screen.getByRole('button', {
      name: '1 chat to check after resuming. Click for details.'
    })
    expect(screen.queryByText(/failed to resume/)).toBeNull()
    await act(async () => entry.click())
    expect(getNativeChatResumeOnRestartDialogRequest()).toBe(true)
    const run = localNativeChatRestartStore.getNativeChatRestartRun()!
    act(() => {
      localNativeChatRestartStore.markFinishedNativeChatRestartRunShown(run)
      localNativeChatRestartStore.releaseFinishedNativeChatRestartRun()
    })
    expect(screen.queryByRole('button')).toBeNull()
  })
})
