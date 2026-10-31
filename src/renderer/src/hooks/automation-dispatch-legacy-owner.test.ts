// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeAutomation, makeRun } from '@/components/automations/automations-page-fixtures'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import {
  resolveAutomationDispatchWorkspace,
  prepareAutomationDispatchWorkspace
} from './automation-dispatch-workspace'

describe('automation legacy workspace ownership', () => {
  it.each(['local', 'unknown', 'twins', 'remote'] as const)(
    'dispatches an unstamped row only with proven local ownership (%s)',
    async (kind) => {
      const worktree = makeWorktree({
        id: 'existing',
        repoId: TEST_REPO.id,
        path: '/repo',
        hostId: undefined
      })
      const local = { ...TEST_REPO, path: '/repo', executionHostId: 'local' as const }
      const remote = { ...local, executionHostId: 'ssh:other' as const, connectionId: 'other' }
      const state = {
        ...useAppStore.getInitialState(),
        repos:
          kind === 'unknown'
            ? []
            : kind === 'remote'
              ? [remote]
              : kind === 'twins'
                ? [remote, local]
                : [local],
        allWorktrees: () => [worktree]
      }
      const automation = makeAutomation({
        projectId: TEST_REPO.id,
        workspaceMode: 'existing',
        workspaceId: worktree.id,
        runContext: {
          kind: 'workspace-run',
          projectId: 'project',
          repoId: TEST_REPO.id,
          hostId: 'local',
          path: '/repo',
          projectHostSetupId: 'setup'
        }
      })
      const run = makeRun({ trigger: 'manual' })
      const resolved = resolveAutomationDispatchWorkspace(state, automation, run)
      expect(resolved.automationWorktree).toEqual(kind === 'local' ? worktree : undefined)
      const markDispatchResult = vi.fn(async () => {})
      const prepared = await prepareAutomationDispatchWorkspace({
        state,
        automation,
        run,
        dispatchToken: 'claim',
        resolved: { ...resolved, repo: local, automationWorktree: worktree },
        markDispatchResult
      })
      expect(prepared).toEqual(kind === 'local' ? worktree : null)
      expect(markDispatchResult).toHaveBeenCalledTimes(kind === 'local' ? 0 : 1)
      if (kind !== 'local') {
        expect(markDispatchResult).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'skipped_unavailable' })
        )
      }
    }
  )
})
