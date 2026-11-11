import { isRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { useEffect } from 'react'
import type { PtyTransport } from '../pty-transport-types'
import {
  releaseRendererPtyVisibilityClaim,
  setRendererPtyVisibilityClaim
} from './pty-renderer-delivery-claims'

function reportRendererPtyVisibility(
  paneTransports: ReadonlyMap<number, PtyTransport>,
  visible: boolean
): void {
  for (const transport of paneTransports.values()) {
    const ptyId = transport.getPtyId()
    if (!ptyId || isRemoteRuntimePtyId(ptyId)) {
      // Remote-runtime relay PTYs bypass main’s local visibility registry.
      continue
    }
    setRendererPtyVisibilityClaim(transport, ptyId, visible)
  }
}

export function useRendererPtyVisibilityClaims({
  paneTransportsRef,
  rendererVisible
}: {
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  rendererVisible: boolean
}): void {
  useEffect(() => {
    const paneTransports = paneTransportsRef.current
    reportRendererPtyVisibility(paneTransports, rendererVisible)
    return () => {
      for (const transport of paneTransports.values()) {
        releaseRendererPtyVisibilityClaim(transport)
      }
    }
  }, [rendererVisible, paneTransportsRef])
}
