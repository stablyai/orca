import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import {
  getExecutionHostLabel,
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId
} from '../../../../shared/execution-host'
import { getFileExplorerOperationOwnerFromState } from './file-explorer-operation-owner'
import {
  getHostBrowseSource,
  hasDesktopHostBrowseApi,
  type HostBrowseSource
} from './file-explorer-host-mode'
import {
  useFileExplorerHostBrowser,
  type FileExplorerHostBrowser
} from './use-file-explorer-host-browser'

export type FileExplorerHostMode = {
  active: boolean
  hostLabel: string
  filterQuery: string
  setFilterQuery: (query: string) => void
  enter: () => void
  exit: () => void
  /** False when this workspace's host cannot be browsed from this client. */
  available: boolean
  browser: FileExplorerHostBrowser
}

type HostVisit = { worktreeId: string; hostKey: string; entry: number }

function getHostKey(source: HostBrowseSource | null): string | null {
  if (!source) {
    return null
  }
  return source.kind === 'ssh' ? `ssh:${source.connectionId}` : 'local'
}

/** Host mode is a session-only visit to one workspace; leaving the workspace ends it. */
export function useFileExplorerHostMode({
  activeWorktreeId,
  worktreePath
}: {
  activeWorktreeId: string | null
  worktreePath: string | null
}): FileExplorerHostMode {
  const [visit, setVisit] = useState<HostVisit | null>(null)
  const [filterQuery, setFilterQuery] = useState('')
  // Why: every entry gets a fresh browsing session, so a later visit never reuses an old listing.
  const entryCounterRef = useRef(0)
  const owner = useAppStore(
    useShallow((s) => getFileExplorerOperationOwnerFromState(s, activeWorktreeId))
  )
  const source = useMemo(() => getHostBrowseSource(owner, hasDesktopHostBrowseApi()), [owner])
  const hostKey = getHostKey(source)
  // Why: a visit belongs to one workspace on one host. Leaving the workspace, losing the host
  // (e.g. owner briefly unresolved during reconnect) or repointing it to another host ends the
  // visit, so a listing from another machine is never shown or clicked. Adjusted during render,
  // not in an effect, so a stale visit never paints.
  if (visit && (visit.worktreeId !== activeWorktreeId || visit.hostKey !== hostKey)) {
    setVisit(null)
    setFilterQuery('')
  }
  const active = visit !== null

  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const hostLabel =
    source?.kind === 'ssh'
      ? (sshTargetLabels.get(source.connectionId) ??
        getExecutionHostLabel(toSshExecutionHostId(source.connectionId)))
      : getExecutionHostLabel(LOCAL_EXECUTION_HOST_ID)

  const browser = useFileExplorerHostBrowser({
    visitKey: active ? `${visit.entry}` : null,
    source,
    worktreeId: activeWorktreeId,
    worktreePath
  })

  const enter = useCallback(() => {
    if (hostKey && activeWorktreeId) {
      setVisit({ worktreeId: activeWorktreeId, hostKey, entry: ++entryCounterRef.current })
    }
  }, [activeWorktreeId, hostKey])
  const exit = useCallback(() => {
    setVisit(null)
    setFilterQuery('')
  }, [])

  // Why: a workspace Contents search (seed or focus request) must be visible, not run behind the Host overlay.
  useEffect(() => {
    if (!active || !activeWorktreeId) {
      return
    }
    return useAppStore.subscribe((state, prev) => {
      const next = state.fileSearchStateByWorktree[activeWorktreeId]
      const before = prev.fileSearchStateByWorktree[activeWorktreeId]
      if (
        next?.seedRequestId !== before?.seedRequestId ||
        next?.focusRequestId !== before?.focusRequestId
      ) {
        exit()
      }
    })
  }, [active, activeWorktreeId, exit])

  const available = source !== null
  return useMemo(
    () => ({ active, available, hostLabel, filterQuery, setFilterQuery, enter, exit, browser }),
    [active, available, hostLabel, filterQuery, enter, exit, browser]
  )
}
