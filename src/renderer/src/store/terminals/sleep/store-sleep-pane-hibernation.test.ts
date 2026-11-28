import { describe, it, expect, vi } from 'vitest'
import { createTestStore, seedStore } from '../../testing/app-store-test-fixture'
import { makeTab } from '../testing/terminal-tab.test-fixture'
import { makeWorktree } from '../../slices/worktrees/worktree.test-fixture'
import { noteArmsHibernatedPaneWake } from '@/components/terminal-pane/pty-connection/lifecycle/hibernated-pane-wake'

vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({}))

vi.mock('@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-data-suspension', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn(() => [])
}))

describe('completed-agent pane hibernation', () => {
  // The killed agent reports SessionEnd (done + failure) while its PTY stops; that echo must not rewrite the resume record.
  it('keeps a wakeable sleep record when the stopping agent reports a late failed status', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const leaf = '11111111-1111-4111-8111-111111111111'
    const paneKey = `tab-1:${leaf}`
    seedStore(store, {
      worktreesByRepo: { repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })] },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Droid', ptyId: 'pty-agent' })]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: leaf },
          activeLeafId: leaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leaf]: 'pty-agent' }
        }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-agent'] }
    })
    const routing = { tabId: 'tab-1', worktreeId: wt }
    const providerSession = { key: 'session_id' as const, id: 'target-session' }
    const reportDone = (updatedAt: number, outcome: 'success' | 'failure'): void =>
      store.getState().setAgentStatus(
        paneKey,
        {
          state: 'done',
          prompt: 'resume target',
          agentType: 'droid',
          mainAgent: { state: 'done', outcome, stateStartedAt: updatedAt }
        },
        'Droid',
        { updatedAt, stateStartedAt: updatedAt },
        routing,
        { providerSession }
      )
    reportDone(2000, 'success')
    vi.stubGlobal('window', {
      api: { pty: { kill: vi.fn(async () => reportDone(3000, 'failure')) } }
    })

    await store.getState().shutdownCompletedAgentPaneForHibernation(wt, {
      paneKey,
      tabId: 'tab-1',
      leafId: leaf,
      ptyId: 'pty-agent'
    })

    const record = store.getState().sleepingAgentSessionsByPaneKey[paneKey]
    expect(record).toMatchObject({ origin: 'worktree-sleep', providerSession })
    expect(noteArmsHibernatedPaneWake(record)).toBe(true)
  })
})
