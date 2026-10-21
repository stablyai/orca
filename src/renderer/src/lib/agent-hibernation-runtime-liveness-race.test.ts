import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { runAgentHibernationTick } from './agent-hibernation-coordinator'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../runtime/runtime-compatibility-test-fixture'
import {
  deferred,
  entry,
  installEligibleState,
  layout,
  LEAF,
  mockRuntimeEnvironmentCall,
  resetAgentHibernationCoordinatorFixture,
  runtimeListResult,
  tab
} from './agent-hibernation-coordinator-test-fixture'

afterEach(resetAgentHibernationCoordinatorFixture)

describe('agent sleep coordinator runtime-liveness races', () => {
  it('requires host evidence when a workspace becomes runtime-owned during an inventory request', async () => {
    const delayed = deferred<ReturnType<typeof runtimeListResult>>()
    const lateTab = { ...tab(), id: 'tab-late', worktreeId: 'wt-late' }
    const lateEntry = {
      ...entry(),
      tabId: 'tab-late',
      worktreeId: 'wt-late',
      paneKey: `tab-late:${LEAF}`
    }
    const lateList = {
      ...runtimeListResult(['pty-late']),
      terminals: runtimeListResult(['pty-late']).terminals.map((terminal) => ({
        ...terminal,
        worktreeId: 'wt-late'
      }))
    }
    let firstListPending = true
    mockRuntimeEnvironmentCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
      if (compatible) {
        return Promise.resolve(compatible)
      }
      if (args.method !== 'terminal.list') {
        return Promise.resolve({ id: 'default', ok: true, result: {} })
      }
      const isLate = args.params?.worktree === 'id:wt-late'
      if (!isLate && firstListPending) {
        firstListPending = false
        return delayed.promise.then((result) => ({
          id: 'delayed',
          ok: true,
          result
        }))
      }
      return Promise.resolve({
        id: 'terminal-list',
        ok: true,
        result: isLate ? lateList : runtimeListResult(['pty-1'])
      })
    })
    // Why: `wt-late` starts local-owned, so the pre-await target sample never lists it.
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined), {
      worktreesByRepo: {
        'fixture-repo': [
          {
            id: 'wt-bg',
            repoId: 'fixture-repo',
            hostId: 'runtime:runtime-1',
            runtimeOwnerEnvironmentId: 'runtime-1'
          },
          { id: 'wt-late', repoId: 'fixture-repo', hostId: 'local' }
        ]
      } as never,
      tabsByWorktree: { 'wt-bg': [tab()], 'wt-late': [lateTab] },
      terminalLayoutsByTabId: {
        'tab-1': layout(),
        'tab-late': {
          root: { type: 'leaf', leafId: LEAF },
          activeLeafId: LEAF,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF]: 'pty-late' }
        }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'], 'tab-late': ['pty-late'] },
      agentStatusByPaneKey: {
        [entry().paneKey]: entry(),
        [lateEntry.paneKey]: lateEntry
      }
    })

    const tick = runAgentHibernationTick()
    await vi.waitFor(() =>
      expect(mockRuntimeEnvironmentCall).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.list' })
      )
    )
    // Runtime ownership resolves while the `wt-bg` inventory is still outstanding.
    useAppStore.setState({
      worktreesByRepo: {
        'fixture-repo': ['wt-bg', 'wt-late'].map((id) => ({
          id,
          repoId: 'fixture-repo',
          hostId: 'runtime:runtime-1',
          runtimeOwnerEnvironmentId: 'runtime-1'
        }))
      } as never
    })
    delayed.resolve(runtimeListResult(['pty-1']))
    await tick

    // The racing pass has no host evidence for `wt-late`, so it must not count as one of
    // the two confirmations; hibernating on the next tick would rest on client PTYs alone.
    await runAgentHibernationTick()
    expect(shutdown).not.toHaveBeenCalledWith('wt-late', expect.anything())

    await runAgentHibernationTick()
    expect(shutdown).toHaveBeenCalledWith(
      'wt-late',
      expect.objectContaining({
        ptyId: 'pty-late',
        expectedRuntimePtyId: 'pty-late'
      })
    )
  })
})
