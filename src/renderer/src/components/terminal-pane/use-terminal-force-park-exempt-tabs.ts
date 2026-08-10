import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { TerminalParkWorktreeOwner } from './terminal-park-pty-restore-eligibility'
import {
  selectEvictionExemptTerminalTabIds,
  selectEvictionExemptTerminalTabLayoutKey
} from './terminal-eviction-exempt-tabs'
import type { ParkableTerminalTabModel } from './terminal-parked-tab-watchers'

const EMPTY_TAB_IDS: ReadonlySet<string> = new Set()

export function useTerminalForceParkExemptTabIds(args: {
  isForceParked: boolean
  tabs: readonly ParkableTerminalTabModel[]
  worktreeId: string
  worktreeOwner: TerminalParkWorktreeOwner
  authorityRevisionKey: string
}): ReadonlySet<string> {
  const { authorityRevisionKey, isForceParked, tabs, worktreeId, worktreeOwner } = args
  const layoutKey = useAppStore((state) =>
    isForceParked ? selectEvictionExemptTerminalTabLayoutKey(state, tabs) : ''
  )
  const worktreeOwnerKey = JSON.stringify(worktreeOwner)
  return useMemo(
    () =>
      isForceParked
        ? selectEvictionExemptTerminalTabIds(worktreeId, tabs, worktreeOwner)
        : EMPTY_TAB_IDS,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the keys encode the store and external authority read by the selector.
    [authorityRevisionKey, isForceParked, layoutKey, tabs, worktreeId, worktreeOwnerKey]
  )
}
