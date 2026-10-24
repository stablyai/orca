import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import {
  commitTerminalViewParking,
  detachTerminalViewParking,
  getTerminalViewParkingSnapshot,
  projectTerminalViewParking,
  subscribeTerminalViewParking,
  type TerminalViewParkingInput
} from './terminal-view-parking-owner'

/** Views publish only committed inputs; the app root owns clocks and watchers. */
export function useTerminalTabColdParking(args: TerminalViewParkingInput): ReadonlySet<string> {
  const host = useRef({})
  const subscribe = useCallback(
    (listener: () => void) => subscribeTerminalViewParking(args.worktreeId, listener),
    [args.worktreeId]
  )
  const snapshot = useCallback(
    () => getTerminalViewParkingSnapshot(args.worktreeId),
    [args.worktreeId]
  )
  useSyncExternalStore(subscribe, snapshot, snapshot)
  const parked = projectTerminalViewParking(args)
  useLayoutEffect(() => {
    commitTerminalViewParking(host.current, args, parked)
  })
  useEffect(() => {
    const token = host.current
    return () => detachTerminalViewParking(token, args.worktreeId)
  }, [args.worktreeId])
  return parked
}
