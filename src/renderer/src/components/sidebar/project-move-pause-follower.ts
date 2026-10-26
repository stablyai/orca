import {
  PROJECT_MOVE_PAUSE_PROTOCOL,
  type ProjectMovePauseRequest,
  type ProjectMovePauseResponse
} from '../../../../shared/project-move-pause'
import type { WorkspaceSleepNotice } from '../../../../shared/workspace-sleep'
import { useAppStore } from '@/store'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { persistWorkspaceSessionByHost } from '@/lib/workspace-session-host-persistence'
import { workspaceSleepTarget } from './workspace-sleep-target'
import { followWorkspaceSleep } from './workspace-sleep-follower'

type Pause = {
  worktreeIds: Set<string>
  started: Set<string>
  ended: Map<string, Promise<Error | null>>
  error?: Error
}

/** The handshake and sleep follower share one lifetime, so an old follower cannot claim support. */
export function createProjectMovePauseFollower(
  respond: (response: ProjectMovePauseResponse) => void
): {
  request: (request: ProjectMovePauseRequest) => Promise<void>
  follow: (notice: WorkspaceSleepNotice) => void
} {
  const pauses = new Map<string, Pause>()
  return {
    request: async (request) => {
      const envelope = {
        requestId: request.requestId,
        protocol: PROJECT_MOVE_PAUSE_PROTOCOL
      } as const
      try {
        if (request.protocol !== PROJECT_MOVE_PAUSE_PROTOCOL) {
          throw new Error('project_move_pause_unsupported_protocol')
        }
        if (request.phase === 'release') {
          pauses.delete(request.requestId)
          return
        }
        if (request.phase === 'prepare') {
          const ids = new Set(request.worktreeIds)
          if (
            ids.size === 0 ||
            ids.size !== request.worktreeIds.length ||
            pauses.has(request.requestId)
          ) {
            throw new Error('project_move_pause_invalid_scope')
          }
          if (
            [...pauses.values()].some((pause) => [...ids].some((id) => pause.worktreeIds.has(id)))
          ) {
            throw new Error('project_move_pause_scope_busy')
          }
          const state = useAppStore.getState()
          const targets = [...ids].map((id) => {
            const target = workspaceSleepTarget(state, id)
            if ('refused' in target) {
              throw new Error(target.refused)
            }
            return target
          })
          pauses.set(request.requestId, { worktreeIds: ids, started: new Set(), ended: new Map() })
          respond({ ...envelope, phase: 'prepare', targets })
          return
        }
        const pause = pauses.get(request.requestId)
        if (!pause) {
          throw new Error('project_move_pause_not_prepared')
        }
        if (pause.error) {
          throw pause.error
        }
        if (request.successfulWorktreeIds.some((id) => !pause.ended.has(id))) {
          throw new Error('project_move_pause_missing_completion')
        }
        if ([...pause.started].some((id) => !pause.ended.has(id))) {
          throw new Error('project_move_pause_incomplete_sleep')
        }
        const errors = await Promise.all(pause.ended.values())
        const error = errors.find((failure) => failure !== null)
        if (error) {
          throw error
        }
        if (pause.error || pauses.get(request.requestId) !== pause) {
          throw pause.error ?? new Error('project_move_pause_released')
        }
        const state = useAppStore.getState()
        await persistWorkspaceSessionByHost(
          window.api.session,
          buildWorkspaceSessionPayload(state),
          state
        )
        if (pause.error || pauses.get(request.requestId) !== pause) {
          throw pause.error ?? new Error('project_move_pause_released')
        }
        respond({ ...envelope, phase: 'persist' })
      } catch (error) {
        respond({
          ...envelope,
          phase: 'error',
          error: error instanceof Error ? error.message : String(error)
        })
      }
    },
    follow: (notice) => {
      if (notice.phase === 'failed') {
        followWorkspaceSleep(notice)
        return
      }
      const pause = notice.projectMovePauseId ? pauses.get(notice.projectMovePauseId) : undefined
      const prepared = pause?.worktreeIds.has(notice.worktreeId) === true
      for (const other of pauses.values()) {
        if (other.worktreeIds.has(notice.worktreeId) && (other !== pause || !prepared)) {
          other.error = new Error('project_move_pause_sleep_superseded')
        }
      }
      if (pause && prepared && notice.phase === 'started') {
        if (pause.started.has(notice.worktreeId)) {
          pause.error = new Error('project_move_pause_duplicate_sleep')
        }
        pause.started.add(notice.worktreeId)
      }
      const completion = followWorkspaceSleep(notice, {
        keepBrowserTabs: prepared,
        reportTeardownFailure: prepared
      })
      if (pause && prepared && notice.phase === 'ended') {
        if (!pause.started.has(notice.worktreeId) || pause.ended.has(notice.worktreeId)) {
          pause.error = new Error('project_move_pause_unexpected_completion')
        }
        pause.ended.set(
          notice.worktreeId,
          Promise.resolve(completion).then(
            () => null,
            (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
          )
        )
      }
    }
  }
}
