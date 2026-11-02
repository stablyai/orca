import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { getKnownExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { resolveTerminalHandleForPane } from '../terminal-pane/terminal-handle-copy'

/** One boundary from the pane's actual host/binding to a public crew party. */
export function useTerminalCrewIdentity(
  paneKey: string,
  ptyId: string | null,
  worktreeId: string | null
) {
  const hostId = useAppStore((state) =>
    worktreeId ? getKnownExecutionHostIdForWorktree(state, worktreeId) : null
  )
  const remote = ptyId ? parseRemoteRuntimePtyId(ptyId) : null
  const host = parseExecutionHostId(hostId)
  const environmentId =
    remote?.environmentId ?? (host?.kind === 'runtime' ? host.environmentId : null)
  const locallyOwned = host?.kind === 'local' || host?.kind === 'ssh'
  const target = useMemo<RuntimeClientTarget | null>(
    () =>
      environmentId
        ? { kind: 'environment', environmentId }
        : locallyOwned
          ? { kind: 'local' }
          : null,
    [environmentId, locallyOwned]
  )
  const isRemote = remote !== null
  const key = JSON.stringify([paneKey, ptyId, target])
  const [resolved, setResolved] = useState<{ key: string; party: string }>()
  useEffect(() => {
    if (!target || !ptyId || isRemote) {
      return
    }
    const pane = parsePaneKey(paneKey)
    if (!pane) {
      return
    }
    let alive = true
    void resolveTerminalHandleForPane({
      tabId: pane.tabId,
      leafId: pane.leafId,
      ptyId,
      callRuntime: window.api.runtime.call
    })
      .then((party) => {
        if (alive) {
          setResolved({ key, party })
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [key, paneKey, ptyId, target, isRemote])
  return {
    target,
    party: target ? (remote?.handle ?? (resolved?.key === key ? resolved.party : null)) : null
  }
}
