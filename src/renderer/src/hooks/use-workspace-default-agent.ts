import { useCallback, useEffect, useRef, useState } from 'react'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { resolveDesktopWorkspaceDefaultAgent } from '@/lib/desktop-workspace-default-agent'

type WorkspaceDefaultState = { agent: TuiAgent | null } | { error: string }

export function useWorkspaceDefaultAgent(
  repo: string | null | undefined,
  hostId: ExecutionHostId | null | undefined,
  implicit: boolean
) {
  const target = `${repo}\0${hostId}`
  const currentTargetRef = useRef(target)
  currentTargetRef.current = target
  const remote = Boolean(repo && hostId && hostId !== 'local')
  const [resolved, setResolved] = useState<
    { target: string; state: WorkspaceDefaultState } | undefined
  >()
  useEffect(() => {
    if (!remote || !implicit || !repo) {
      return
    }
    let cancelled = false
    void resolveDesktopWorkspaceDefaultAgent({ repo, hostId }).then(
      ({ agent }) => {
        if (!cancelled) {
          setResolved({ target, state: { agent } })
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setResolved({
            target,
            state: { error: error instanceof Error ? error.message : String(error) }
          })
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [repo, hostId, target, remote, implicit])
  const recordAgent = useCallback(
    (agent: TuiAgent | null) => {
      if (currentTargetRef.current !== target) {
        return
      }
      setResolved({ target, state: { agent } })
    },
    [target]
  )
  const state = resolved?.target === target ? resolved.state : null
  const hostDefaultAgent: TuiAgent | 'blank' | undefined =
    state && 'agent' in state ? (state.agent ?? 'blank') : remote ? 'blank' : undefined
  return {
    hostDefaultAgent,
    defaultError: state && 'error' in state ? state.error : null,
    recordAgent,
    defaultPending: remote && implicit && state === null
  }
}
