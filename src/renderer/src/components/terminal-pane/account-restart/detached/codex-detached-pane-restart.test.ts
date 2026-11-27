import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { sweepUnclaimedCodexPaneRestarts } from './codex-detached-pane-restart'

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF}`

function seedRestartableClaudePane(ptyId: string) {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' })]
    },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the restart reads only these fields.
    tabsByWorktree: {
      'wt-1': [{ id: 'tab-1', worktreeId: 'wt-1', generation: 0, startupCwd: '/repo' }]
    } as never,
    ptyIdsByTabId: { 'tab-1': [ptyId] },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the layout read is ptyIdsByLeafId only.
    terminalLayoutsByTabId: { 'tab-1': { ptyIdsByLeafId: { [LEAF]: ptyId } } } as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resume read is agent and providerSession only.
    sleepingAgentSessionsByPaneKey: {
      [PANE_KEY]: {
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'claude-session-1' },
        prompt: '',
        state: 'done',
        capturedAt: 1,
        updatedAt: 1
      }
    } as never
  })
  useAppStore.getState().queuePaneAccountRestarts([ptyId], 'claude')
}

beforeEach(() => {
  seedRestartableClaudePane('pty-1')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

it('asks a failed detached restart again instead of dropping the pane', async () => {
  const spawn = vi.fn().mockRejectedValue(new Error('the spawn failed'))
  vi.stubGlobal('window', { api: { pty: { spawn } } })

  await sweepUnclaimedCodexPaneRestarts()

  expect(spawn).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().pendingPaneAccountRestarts['pty-1']).toBe('claude')
})

it('stops asking after a bounded number of failures', async () => {
  seedRestartableClaudePane('pty-2')
  const spawn = vi.fn().mockRejectedValue(new Error('the spawn failed'))
  vi.stubGlobal('window', { api: { pty: { spawn } } })

  for (let i = 0; i < 10; i++) {
    await sweepUnclaimedCodexPaneRestarts()
  }

  // The first ask plus three more; the queue entry is then spent for good.
  expect(spawn).toHaveBeenCalledTimes(4)
  expect(useAppStore.getState().pendingPaneAccountRestarts['pty-2']).toBeUndefined()
})
