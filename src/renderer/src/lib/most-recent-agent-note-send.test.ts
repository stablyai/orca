import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { TerminalTab } from '../../../shared/types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  selectMostRecentRunningAgentSendTarget,
  sendNotesToMostRecentAgentSession
} from './most-recent-agent-note-send'

const mocks = vi.hoisted(() => ({
  appState: {} as Partial<AppState>,
  sendBracketedPasteToRunningAgent: vi.fn(),
  track: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.appState
  }
}))

vi.mock('./agent-paste-draft', () => ({
  sendBracketedPasteToRunningAgent: mocks.sendBracketedPasteToRunningAgent
}))

vi.mock('./telemetry', () => ({
  track: mocks.track
}))

vi.mock('sonner', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError
  }
}))

const WORKTREE_ID = 'wt-1'
const TAB_ID = 'tab-1'
const OLD_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const NEW_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const OLD_PANE_KEY = makePaneKey(TAB_ID, OLD_LEAF_ID)
const NEW_PANE_KEY = makePaneKey(TAB_ID, NEW_LEAF_ID)

function tab(id: string = TAB_ID): TerminalTab {
  return {
    id,
    worktreeId: WORKTREE_ID,
    ptyId: 'fallback-pty',
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function entry(
  paneKey: string,
  updatedAt: number,
  overrides: Partial<AgentStatusEntry> = {}
): AgentStatusEntry {
  return {
    paneKey,
    state: 'waiting',
    prompt: 'previous prompt',
    updatedAt,
    stateStartedAt: updatedAt,
    agentType: 'codex',
    stateHistory: [],
    ...overrides
  }
}

function stateWithTwoTargets(): Partial<AppState> {
  const now = Date.now()
  return {
    tabsByWorktree: {
      [WORKTREE_ID]: [tab()]
    },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: OLD_LEAF_ID },
          second: { type: 'leaf', leafId: NEW_LEAF_ID }
        },
        activeLeafId: NEW_LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: {
          [OLD_LEAF_ID]: 'pty-old',
          [NEW_LEAF_ID]: 'pty-new'
        }
      }
    },
    agentStatusByPaneKey: {
      [OLD_PANE_KEY]: entry(OLD_PANE_KEY, now - 1000),
      [NEW_PANE_KEY]: entry(NEW_PANE_KEY, now)
    }
  }
}

beforeEach(() => {
  mocks.appState = stateWithTwoTargets()
  mocks.sendBracketedPasteToRunningAgent.mockReset()
  mocks.sendBracketedPasteToRunningAgent.mockResolvedValue(true)
  mocks.track.mockReset()
  mocks.toastSuccess.mockReset()
  mocks.toastError.mockReset()
})

describe('selectMostRecentRunningAgentSendTarget', () => {
  it('picks the eligible agent with the most recent hook update', () => {
    expect(
      selectMostRecentRunningAgentSendTarget(mocks.appState as AppState, WORKTREE_ID)
    ).toMatchObject({
      paneKey: NEW_PANE_KEY,
      ptyId: 'pty-new'
    })
  })

  it('can pick a currently working agent so send waits for it to become ready', () => {
    mocks.appState = {
      ...stateWithTwoTargets(),
      agentStatusByPaneKey: {
        [OLD_PANE_KEY]: entry(OLD_PANE_KEY, Date.now() - 1000),
        [NEW_PANE_KEY]: entry(NEW_PANE_KEY, Date.now(), { state: 'working' })
      }
    }

    expect(
      selectMostRecentRunningAgentSendTarget(mocks.appState as AppState, WORKTREE_ID)
    ).toMatchObject({
      paneKey: NEW_PANE_KEY,
      disabledReason: 'Agent is working'
    })
  })
})

describe('sendNotesToMostRecentAgentSession', () => {
  it('sends notes to the most recent live agent and tracks delivery', async () => {
    const onPromptDelivered = vi.fn()

    await expect(
      sendNotesToMostRecentAgentSession({
        worktreeId: WORKTREE_ID,
        prompt: 'Review these notes',
        launchSource: 'notes_send',
        onPromptDelivered
      })
    ).resolves.toBe(true)

    expect(mocks.sendBracketedPasteToRunningAgent).toHaveBeenCalledWith({
      ptyId: 'pty-new',
      content: 'Review these notes'
    })
    expect(onPromptDelivered).toHaveBeenCalledTimes(1)
    expect(mocks.track).toHaveBeenCalledWith('agent_prompt_sent', {
      agent_kind: 'codex',
      launch_source: 'notes_send',
      request_kind: 'followup'
    })
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Sent to Codex')
  })

  it('shows an error when the worktree has no live agent session', async () => {
    mocks.appState = {
      tabsByWorktree: { [WORKTREE_ID]: [tab()] },
      terminalLayoutsByTabId: {},
      agentStatusByPaneKey: {}
    }

    await expect(
      sendNotesToMostRecentAgentSession({
        worktreeId: WORKTREE_ID,
        prompt: 'Review these notes',
        launchSource: 'notes_send'
      })
    ).resolves.toBe(false)

    expect(mocks.sendBracketedPasteToRunningAgent).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('No agent session available', {
      description: 'Start an agent in this workspace to send notes.'
    })
  })
})
