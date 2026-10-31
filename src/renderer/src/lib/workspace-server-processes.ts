import { useEffect, useState } from 'react'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  WorkspaceServerFrame,
  trimServerLogs,
  type WorkspaceServerSnapshot
} from '../../../shared/workspace-server-process'
import { subscribeRuntimeRpc } from '@/runtime/runtime-rpc-subscribe'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { translate } from '@/i18n/i18n'

export function applyWorkspaceServerFrame(
  runs: WorkspaceServerSnapshot[],
  frame: WorkspaceServerFrame
): WorkspaceServerSnapshot[] {
  if (frame.type === 'snapshot') {
    return frame.runs
  }
  const previous = runs.find((run) => run.port === frame.info.port)
  if (previous && previous.startedAt > frame.info.startedAt) {
    return runs
  }
  const logs = !frame.reset && previous?.id === frame.info.id ? previous.logs : []
  const lastSeq = logs.at(-1)?.seq ?? -1
  const next = {
    ...frame.info,
    logs: trimServerLogs([...logs, ...frame.lines.filter((line) => line.seq > lastSeq)])
  }
  return [...runs.filter((run) => run.port !== next.port), next]
}

type State = {
  key: string
  runs: WorkspaceServerSnapshot[]
  connected: boolean
  error: string | null
}
export function useWorkspaceServerProcesses(
  target: RuntimeClientTarget,
  worktreeId: string,
  executionHostId: string
) {
  const key = JSON.stringify([target, worktreeId, executionHostId])
  const [state, setState] = useState<State>({ key, runs: [], connected: false, error: null })
  useEffect(() => {
    let live = true
    let generation = 0
    let close: (() => void) | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    const open = () => {
      const attempt = ++generation
      const current = () => live && generation === attempt
      const lose = (cause?: unknown) => {
        if (!current()) {
          return
        }
        generation += 1
        close?.()
        close = undefined
        const unsupported =
          typeof cause === 'object' &&
          cause !== null &&
          'code' in cause &&
          cause.code === 'method_not_found'
        const message = unsupported
          ? translate(
              'auto.components.right.sidebar.index.serverHostUnsupported',
              'This Orca host does not support managed server logs. Update the host to use this feature.'
            )
          : translate(
              'auto.components.right.sidebar.index.serverHostDisconnected',
              'Server log connection lost. Reconnecting…'
            )
        setState((previous) => ({
          key,
          runs: previous.key === key ? previous.runs : [],
          connected: false,
          error: message
        }))
        if (!unsupported) {
          retry = setTimeout(open, 5000)
        }
      }
      void subscribeRuntimeRpc(
        target,
        'workspaceServers.subscribe',
        {
          worktree: toRuntimeWorktreeSelector(worktreeId),
          executionHostId: target.kind === 'environment' ? 'local' : executionHostId
        },
        {
          onEvent: (event) => {
            const parsed = WorkspaceServerFrame.safeParse(event)
            if (current() && parsed.success) {
              setState((previous) => ({
                key,
                connected: true,
                error: null,
                runs: applyWorkspaceServerFrame(
                  previous.key === key ? previous.runs : [],
                  parsed.data
                )
              }))
            }
          },
          onError: lose,
          onClose: lose
        }
      ).then((handle) => {
        if (current()) {
          close = handle.unsubscribe
        } else {
          handle.unsubscribe()
        }
      }, lose)
    }
    open()
    return () => {
      live = false
      generation += 1
      clearTimeout(retry)
      close?.()
    }
  }, [key, target, worktreeId, executionHostId])
  return state.key === key ? state : { key, runs: [], connected: false, error: null }
}
