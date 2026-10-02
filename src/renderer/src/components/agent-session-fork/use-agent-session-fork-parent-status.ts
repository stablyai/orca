import { useCallback, useEffect, useRef, useState } from 'react'
import {
  probeParentWorkingTree,
  readParentWorkingTreeChanges,
  type ForkSourceSnapshot,
  type ParentProbe,
  type ParentWorkingTreeChanges
} from './agent-session-fork-parent-probe'

export type ParentStatusForSubmit = {
  changes: ParentWorkingTreeChanges | null
  carrySupported: boolean
}

/** The parent's HEAD, change counts and carry capability, probed on open and re-read on submit. */
export function useAgentSessionForkParentStatus(source: ForkSourceSnapshot) {
  const [changes, setChanges] = useState<ParentWorkingTreeChanges | null>(null)
  const [carrySupported, setCarrySupported] = useState<boolean | null>(null)
  const probeRef = useRef<ParentProbe | null>(null)
  const probeSignalRef = useRef<AbortSignal | null>(null)
  const lastReadRef = useRef<ParentWorkingTreeChanges | null>(null)
  // Why: only the newest read may update the dialog; a slow mount probe must not undo a submit read.
  const readSeqRef = useRef(0)

  useEffect(() => {
    const controller = new AbortController()
    const probe = probeParentWorkingTree(source, controller.signal)
    probeRef.current = probe
    probeSignalRef.current = controller.signal
    const seq = ++readSeqRef.current
    void probe.changes.then((probed) => {
      if (controller.signal.aborted || seq !== readSeqRef.current) {
        return
      }
      if (probed) {
        lastReadRef.current = probed
      }
      setChanges(probed)
    })
    void probe.carrySupported.then((supported) => {
      if (!controller.signal.aborted) {
        setCarrySupported(supported)
      }
    })
    return () => controller.abort()
  }, [source])

  const readForSubmit = useCallback(async (): Promise<ParentStatusForSubmit> => {
    const seq = ++readSeqRef.current
    const [fresh, supported] = await Promise.all([
      readParentWorkingTreeChanges(source, probeSignalRef.current ?? new AbortController().signal),
      probeRef.current?.carrySupported ?? false
    ])
    if (fresh) {
      lastReadRef.current = fresh
    }
    // Why: a failed re-read keeps the last good one; the carry refuses (base_mismatch) if HEAD moved.
    const resolved = fresh ?? lastReadRef.current
    if (seq === readSeqRef.current) {
      setChanges(resolved)
    }
    return { changes: resolved, carrySupported: supported }
  }, [source])

  return { changes, carrySupported, readForSubmit }
}
