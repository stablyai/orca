import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeHookPayload } from '../../../shared/agent-hook-listener'
import {
  createHookListenerState,
  seedLegacyAgentStatusForTests
} from '../../../shared/agent-hook-listener/listener-state'
import { makePaneKey } from '../../../shared/stable-pane-id'

const dispatchTerminalNotification = vi.fn()
const dispatchAgentHookTerminalLifecycle = vi.fn()
const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const SESSION_ID = '9478e2d8-29bc-4009-ab32-657efa2bd763'
const CHILD_SESSION_ID = 'b1c4fb80-4f12-4a6f-9a68-7c0d5f0f5a12'
const HOOK_DONE_QUIET_MS = 1_500

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: {
        experimentalTerminalAttention: false,
        notifications: { enabled: true, agentTaskComplete: true }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      suppressedPtyExitIds: {},
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'pty-1' }] },
      terminalLayoutsByTabId: {},
      agentLaunchConfigByPaneKey: {},
      agentStatusByPaneKey: {},
      getAgentLaunchConfigForStatusEntry: () => undefined
    })
  }
}))

vi.mock('@/components/terminal-pane/use-notification-dispatch', () => ({
  dispatchTerminalNotification
}))
vi.mock('@/components/terminal-pane/agent-hook-terminal-lifecycle', () => ({
  dispatchAgentHookTerminalLifecycle
}))

describe('DSH session-boundary completion notifications', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    dispatchTerminalNotification.mockClear()
    dispatchAgentHookTerminalLifecycle.mockClear()
  })

  afterEach(() => vi.useRealTimers())

  async function createPlayer(): Promise<(name: string, fields?: Record<string, unknown>) => void> {
    const { observeAgentHookCompletionForNotification } =
      await import('./agent-hook-completion-notifications')
    const listener = createHookListenerState()
    return (name, fields = {}) => {
      // Payload fields match @deepseek-ai/dsh-hooks-claude-code 0.2.0-rc.2.
      const event = normalizeHookPayload(
        listener,
        'dsh',
        {
          paneKey: PANE_KEY,
          payload: {
            session_id: SESSION_ID,
            transcript_path: '',
            cwd: '/tmp/ws',
            hook_event_name: name,
            ...fields
          }
        },
        'production'
      )
      if (!event) {
        return
      }
      seedLegacyAgentStatusForTests(listener, event)
      observeAgentHookCompletionForNotification({
        paneKey: PANE_KEY,
        worktreeId: 'wt-1',
        payload: event.payload
      })
    }
  }

  it.each(['startup', 'resume', 'clear'])(
    'does not announce %s as completion, but still announces a real turn end',
    async (source) => {
      const play = await createPlayer()
      play('SessionStart', { source })
      vi.advanceTimersByTime(HOOK_DONE_QUIET_MS * 2)
      expect(dispatchTerminalNotification).not.toHaveBeenCalled()

      play('UserPromptSubmit', { prompt: 'finish the task' })
      play('Stop', { stop_hook_active: false })
      vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)
      expect(dispatchTerminalNotification).toHaveBeenCalledTimes(1)
      expect(dispatchTerminalNotification).toHaveBeenCalledWith(
        'wt-1',
        expect.objectContaining({
          agentStatusSnapshot: expect.objectContaining({ state: 'done', agentType: 'dsh' })
        })
      )
    }
  )

  it('does not announce a child SessionStart while the lead is running', async () => {
    const play = await createPlayer()
    play('UserPromptSubmit', { prompt: 'delegate a review and keep working' })
    play('SessionStart', { source: 'startup', session_id: CHILD_SESSION_ID })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS * 2)
    expect(dispatchTerminalNotification).not.toHaveBeenCalled()
  })

  it('does not announce compaction as completion', async () => {
    const play = await createPlayer()
    play('UserPromptSubmit', { prompt: 'continue after compaction' })
    play('SessionStart', { source: 'compact' })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS * 2)
    expect(dispatchTerminalNotification).not.toHaveBeenCalled()

    play('Stop', { stop_hook_active: false })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)
    expect(dispatchTerminalNotification).toHaveBeenCalledTimes(1)
  })
})
