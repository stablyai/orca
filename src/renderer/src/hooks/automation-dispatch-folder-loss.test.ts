import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AutomationDispatchRequest,
  AutomationDispatchResult
} from '../../../shared/automations-types'
import {
  makeAutomation,
  makeRun,
  makeWorktree
} from '@/components/automations/automations-page-fixtures'

const { state, markDispatchResult, launch } = vi.hoisted(() => {
  const folderWorkspaces: {
    id: string
    projectGroupId: string
    folderPath: string
    executionHostId: string
  }[] = []
  return {
    state: {
      activeWorktreeId: null,
      activeWorkspaceHostId: null,
      repos: [{ id: 'repo', path: '/project', executionHostId: 'local' }],
      projectGroups: [],
      folderWorkspaces,
      allWorktrees: vi.fn(),
      createWorktree: vi.fn(),
      agentStatusByPaneKey: {}
    },
    markDispatchResult: vi.fn<(result: AutomationDispatchResult) => Promise<void>>(async () => {}),
    launch: vi.fn()
  }
})
vi.mock('@/store', () => ({
  useAppStore: { getState: () => state, subscribe: () => () => {} }
}))
vi.mock('@/lib/launch-agent-background-session', () => ({ launchAgentBackgroundSession: launch }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import { handleAutomationDispatchRequest } from './automation-dispatch-handler'

describe('claimed automation folder loss', () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each(['existing', 'new_per_run'] as const)(
    'forwards authored launch inputs from a claimed %s run to its background session',
    async (workspaceMode) => {
      vi.clearAllMocks()
      const worktree = makeWorktree({ id: 'run-workspace', repoId: 'repo', hostId: 'local' })
      state.allWorktrees.mockReturnValue([worktree])
      state.createWorktree.mockResolvedValue({ worktree })
      launch.mockResolvedValue({
        tabId: 'tab',
        paneKey: 'tab:leaf',
        ptyId: 'pty',
        terminalOwnership: null,
        releaseRuntimeObservers: vi.fn()
      })
      vi.stubGlobal('window', { api: { automations: { markDispatchResult } } })
      const automation = makeAutomation({
        projectId: 'repo',
        runContext: {
          kind: 'workspace-run',
          projectId: 'project',
          projectHostSetupId: 'setup',
          repoId: 'repo',
          hostId: 'local',
          path: '/project'
        },
        workspaceMode,
        workspaceId: workspaceMode === 'existing' ? worktree.id : null,
        agentId: 'claude',
        launchPreferences: { options: { fastMode: 'true' }, permissionMode: 'ask' },
        agentArgs: '--add-dir "automation docs"',
        extraAgentArgs: '--effort high'
      })
      const run = makeRun({ id: 'run-claimed', trigger: 'manual' })
      await handleAutomationDispatchRequest({ automation, run, dispatchToken: 'claim' })

      expect(markDispatchResult.mock.calls[0]?.[0]?.error).toBeNull()
      expect(launch).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          agent: 'claude',
          worktreeId: worktree.id,
          prompt: automation.prompt,
          agentArgs: '--add-dir "automation docs"',
          sessionOptions: { fastMode: 'true', permissionMode: 'ask' },
          extraAgentArgs: '--effort high'
        })
      )
      expect(markDispatchResult).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          runId: run.id,
          status: 'dispatched',
          terminalPaneKey: 'tab:leaf'
        })
      )
    }
  )

  it.each(['removed', 'ambiguous', 'mixed-host'])(
    'settles a claimed run when its folder becomes %s before renderer dispatch',
    async (kind) => {
      vi.clearAllMocks()
      state.folderWorkspaces =
        kind === 'removed'
          ? []
          : [
              { id: 'saved', projectGroupId: 'g', folderPath: '/first', executionHostId: 'local' },
              {
                id: 'saved',
                projectGroupId: 'g',
                folderPath: '/second',
                executionHostId: kind === 'mixed-host' ? 'ssh:other' : 'local'
              }
            ]
      vi.stubGlobal('window', { api: { automations: { markDispatchResult } } })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this claimed-run fixture supplies the identity and existing-target members the real handler reads before settlement.
      const request = {
        automation: {
          id: 'a',
          projectId: 'repo',
          runContext: { repoId: 'repo', hostId: 'local', path: '/project' },
          workspaceMode: 'existing',
          workspaceId: 'folder:saved'
        },
        run: { id: 'run-claimed', trigger: 'manual' },
        dispatchToken: 'claim'
      } as AutomationDispatchRequest
      await handleAutomationDispatchRequest(request)
      expect(markDispatchResult).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          runId: 'run-claimed',
          status: 'skipped_unavailable',
          workspaceId: 'folder:saved',
          error:
            kind === 'removed'
              ? 'The target workspace is no longer available.'
              : 'The target workspace spans more than one host, so this run has no single host to use.'
        })
      )
      expect(launch).not.toHaveBeenCalled()
    }
  )
})
