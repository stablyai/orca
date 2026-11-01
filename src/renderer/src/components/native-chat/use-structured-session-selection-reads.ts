import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { subscribeRuntimeHostContactRegained } from '@/runtime/runtime-host-contact-regained'
import type { structuredSessionSelectionAuthority } from '@/lib/structured-agent-session-selection-controller'
import type { StructuredSessionSelectionController } from '../../../../shared/structured-agent-session-selection-operations'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

/** Revalidate the queried base when local operations finish or host authority moves. */
export function useStructuredSessionSelectionReads(args: {
  controller: StructuredSessionSelectionController
  target: RuntimeClientTarget
  authority: ReturnType<typeof structuredSessionSelectionAuthority>
  hostOptionStamp: string
  turnId: string | null
  rereadOptions: () => void
}) {
  const { controller, target, authority, hostOptionStamp, turnId, rereadOptions } = args
  const [, setContact] = useState(0)
  const selectionRevision = useSyncExternalStore(controller.subscribe, controller.snapshot)
  const terminal = controller.terminalSnapshot()
  const readStamp = JSON.stringify([hostOptionStamp, turnId])
  const seenReadStamp = useRef(readStamp)
  useEffect(() => {
    if (seenReadStamp.current !== readStamp) {
      seenReadStamp.current = readStamp
      rereadOptions()
    }
  }, [readStamp, rereadOptions])
  useEffect(() => {
    if (terminal) {
      rereadOptions()
    }
  }, [terminal, rereadOptions])
  useEffect(
    () =>
      target.kind === 'environment'
        ? subscribeRuntimeHostContactRegained(target.environmentId, () => {
            setContact((value) => value + 1)
            rereadOptions()
          })
        : undefined,
    [target, authority, controller, rereadOptions]
  )
  return selectionRevision
}
