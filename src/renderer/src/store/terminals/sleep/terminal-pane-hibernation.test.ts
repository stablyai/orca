import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree } from '../../slices/worktrees/worktree.test-fixture'

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = `tab-1:${LEAF}`

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' })]
    },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the binding check reads only the tab id.
    tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] } as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the binding check reads only ptyIdsByLeafId.
    terminalLayoutsByTabId: { 'tab-1': { ptyIdsByLeafId: { [LEAF]: 'pty-1' } } } as never,
    ptyIdsByTabId: { 'tab-1': ['pty-1'] }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

it('keeps a pane the user came back to while main admitted its sleep', async () => {
  const kill = vi.fn()
  vi.stubGlobal('window', {
    api: { pty: { sleepAdmitted: async () => ({ admitted: true }), kill } }
  })

  await expect(
    useAppStore.getState().shutdownCompletedAgentPaneForHibernation('wt-1', {
      paneKey: PANE,
      tabId: 'tab-1',
      leafId: LEAF,
      ptyId: 'pty-1',
      stillEligible: async () => false
    })
  ).rejects.toThrow('agent_hibernation_candidate_changed')
  expect(kill).not.toHaveBeenCalled()
})
