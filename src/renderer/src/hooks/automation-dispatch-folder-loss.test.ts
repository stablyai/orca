import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AutomationDispatchRequest } from '../../../shared/automations-types'

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
      folderWorkspaces
    },
    markDispatchResult: vi.fn(async () => {}),
    launch: vi.fn()
  }
})
vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
vi.mock('@/lib/launch-agent-background-session', () => ({ launchAgentBackgroundSession: launch }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import { handleAutomationDispatchRequest } from './automation-dispatch-handler'

describe('claimed automation folder loss', () => {
  afterEach(() => vi.unstubAllGlobals())

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
