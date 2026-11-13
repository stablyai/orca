import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActiveAgentNotesSendResult } from '@/lib/agent-session/messaging/terminal/active-agent-note-send-result'
import type { AppState } from '../../types'
import { createUiAgentActions } from './ui-slice-agent-actions'

const mocks = vi.hoisted(() => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
  sendMessageToAgent: vi.fn(),
  revealAgentTerminal: vi.fn()
}))

vi.mock('sonner', () => ({ toast: mocks.toast }))
vi.mock('@/lib/agent-session/messaging/agent-message-send', () => ({
  sendMessageToAgent: mocks.sendMessageToAgent
}))
vi.mock('@/lib/agent-session/messaging/terminal/active-agent-note-send', () => ({}))
vi.mock('@/components/native-chat/selection-quotes/native-chat-workspace-selection', () => ({
  revealAgentTerminal: mocks.revealAgentTerminal
}))
vi.mock('../../../lib/agent-session/messaging/running-agent-targets', () => ({
  deriveRunningAgentSendTargets: () => [],
  resolveRunningAgentSendTarget: () => ({ kind: 'terminal', status: 'eligible', ptyId: 'pty-1' }),
  runningAgentMessageTarget: () => ({ kind: 'terminal', tabId: 'tab-1', leafId: 'leaf-1' }),
  runningAgentSendTargetAgentType: () => 'antigravity'
}))

async function sendRefusedWith(result: ActiveAgentNotesSendResult) {
  mocks.sendMessageToAgent.mockResolvedValue(result)
  let state: AppState
  const get = (): AppState => state
  const set = (next: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void => {
    state = { ...state, ...(typeof next === 'function' ? next(state) : next) }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the send action reads only the members this double provides.
  state = createUiAgentActions(set as never, get as never) as AppState
  set({
    agentSendPopoverTargetMode: {
      id: 'notes',
      instanceId: 'one',
      worktreeId: 'wt-1',
      source: 'diff-notes',
      prompt: 'note',
      label: 'Notes',
      launchSource: 'notes_send',
      eligiblePaneKeys: ['tab-1:leaf-1'],
      disabledPaneKeys: {},
      status: 'open'
    }
  })
  const sent = await state.sendPromptToSidebarAgentTarget('tab-1:leaf-1')
  return { sent, mode: state.agentSendPopoverTargetMode }
}

describe('a sidebar send refused over a pasted note waiting for Enter', () => {
  beforeEach(() => {
    for (const mock of [...Object.values(mocks.toast), mocks.revealAgentTerminal]) {
      mock.mockReset()
    }
  })

  it('is not reported as a failed send, and offers the way to that terminal', async () => {
    const { sent, mode } = await sendRefusedWith({
      status: 'not-ready',
      code: 'terminal-draft-pending'
    })
    expect(sent).toBe(false)
    expect(mode).toMatchObject({ status: 'open', prompt: 'note' })
    expect(mode?.error).toBeUndefined()
    expect(mocks.toast.error).not.toHaveBeenCalled()
    mocks.toast.info.mock.calls[0][1].action.onClick()
    expect(mocks.revealAgentTerminal).toHaveBeenCalledWith('wt-1', {
      kind: 'terminal',
      tabId: 'tab-1',
      leafId: 'leaf-1'
    })
  })

  it('leaves any other refusal a failed send', async () => {
    const { mode } = await sendRefusedWith({ status: 'not-ready', code: 'terminal-send-busy' })
    expect(mode?.status).toBe('error')
    expect(mocks.toast.info).not.toHaveBeenCalled()
  })
})
