import {
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host/execution-host'

/** A window event that names the host it's about; listeners hear only their own host's. */
export function hostWindowEvent(name: string): {
  emit: (hostId: ExecutionHostId) => void
  on: (listener: () => void, hostId: ExecutionHostId) => () => void
} {
  return {
    emit: (hostId) => {
      window.dispatchEvent(new CustomEvent(name, { detail: { hostId } }))
    },
    on: (listener, hostId) => {
      const handle = (event: Event): void => {
        const detail: unknown = event instanceof CustomEvent ? event.detail : undefined
        if (
          detail &&
          typeof detail === 'object' &&
          'hostId' in detail &&
          typeof detail.hostId === 'string' &&
          normalizeExecutionHostId(detail.hostId) === hostId
        ) {
          listener()
        }
      }
      window.addEventListener(name, handle)
      return () => window.removeEventListener(name, handle)
    }
  }
}
