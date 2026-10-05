import { describe, expect, it, vi } from 'vitest'
import { createAgentStatusStore } from './agent-status-store'
import { TmuxAgentHookOwner } from './tmux-agent-hook-owner'
import { commitTmuxSelectedStatus } from './tmux-selected-status'
import { TMUX_TEST_PANE, TMUX_TEST_ROOT, tmuxTestBody } from './tmux-status.test-fixture'
import type { AgentStatusPtySubject } from './agent-status-subject'

describe('tmux refresh retirement during root resolution', () => {
  it.each([
    ['clear-pane', 'same-root'],
    ['clear-pane', 'replacement-root'],
    ['stop', 'same-root'],
    ['stop', 'replacement-root']
  ])('preserves newer authority after %s with %s', async (boundary, rootCase) => {
    const store = createAgentStatusStore({ epoch: 'tmux-retirement', mode: 'authority' })
    let finish = (_root: typeof TMUX_TEST_ROOT) => {}
    const pending = new Promise<typeof TMUX_TEST_ROOT>((resolve) => {
      finish = resolve
    })
    const getRoot = vi
      .fn(async () => TMUX_TEST_ROOT)
      .mockResolvedValueOnce(TMUX_TEST_ROOT)
      .mockImplementationOnce(() => pending)
    const unavailable = vi.fn((_pane: string, subject?: AgentStatusPtySubject) => {
      if (subject) {
        store.applyMutation({ parent: { subject } })
      }
    })
    const owner = new TmuxAgentHookOwner({
      store: () => store,
      getRoot,
      probe: async () => ({ clients: [], rows: [] }),
      isRetired: () => false,
      publish: (event, time, subject, start) => {
        commitTmuxSelectedStatus(store, subject, event, time, start)
      },
      unavailable
    })
    try {
      const refresh = owner.ingest('opencode', tmuxTestBody(), 'production')
      await vi.waitFor(() => expect(getRoot).toHaveBeenCalledTimes(2))
      if (boundary === 'stop') {
        owner.stop()
      } else {
        owner.clearPane(TMUX_TEST_PANE)
      }
      const current =
        rootCase === 'same-root'
          ? TMUX_TEST_ROOT
          : { ...TMUX_TEST_ROOT, pid: 200, incarnation: 'replacement' }
      const subject = { ...current.scope, kind: 'pty' as const, paneKey: TMUX_TEST_PANE }
      commitTmuxSelectedStatus(
        store,
        subject,
        {
          paneKey: TMUX_TEST_PANE,
          tabId: 'tab-tmux',
          worktreeId: 'workspace',
          source: 'opencode2',
          connectionId: null,
          launchToken: 'new-generation',
          payload: {
            agentType: 'opencode2',
            state: 'waiting',
            toolName: 'shell',
            prompt: 'new turn'
          }
        },
        100
      )
      const before = store.getParent(subject)
      expect(before?.status?.state).toBe('waiting')
      finish(current)
      await refresh
      expect(store.getParent(subject)).toEqual(before)
      expect(unavailable).not.toHaveBeenCalled()
    } finally {
      finish(TMUX_TEST_ROOT)
      owner.stop()
    }
  })
})
