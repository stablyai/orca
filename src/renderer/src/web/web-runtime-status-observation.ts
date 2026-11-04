import { readWebRuntimeStatus } from './web-runtime-status-request'
import { RuntimeHostStatusOwner } from '../../../shared/remote-runtime/host-status/runtime-host-status-owner'
import type {
  RuntimeHostStatusSnapshot,
  RuntimeHostStatusResponse
} from '../../../shared/remote-runtime/host-status/runtime-host-status'
import type { WebRuntimeConnectionTransport } from './web-runtime-connection-transport'

export type WebRuntimeStatusOptions = {
  environmentId: string
  pairingRevision: number
  publish: (snapshot: RuntimeHostStatusSnapshot) => void
  verified: (response: RuntimeHostStatusResponse) => void
}

export function createWebRuntimeStatusOwner(
  transport: WebRuntimeConnectionTransport,
  status: WebRuntimeStatusOptions
): RuntimeHostStatusOwner {
  return new RuntimeHostStatusOwner({
    ...status,
    persistent: true,
    request: (signal) => readWebRuntimeStatus(transport, signal),
    verified: (response) => {
      status.verified(response)
      return true
    }
  })
}

export function observeWebRuntimeStatusForeground(
  isDocumentVisible: () => boolean,
  wake: () => void
): (() => void) | undefined {
  const foreground = () => {
    if (isDocumentVisible()) {
      wake()
    }
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', foreground)
    return () => document.removeEventListener('visibilitychange', foreground)
  }
  return undefined
}
