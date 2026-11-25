import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type {
  WorkspaceCleanupPolicyChange,
  WorkspaceCleanupPolicyRead
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy-change'
import {
  cleanupWritePhase,
  dispatchCleanupWrite,
  retryCleanupWrite,
  subscribeCleanupWrite
} from './workspace-cleanup-pending-write'

export function useWorkspaceCleanupPolicyWrite(owner: RuntimeClientTarget, scopeKey: string) {
  const dispatched = useRef<ReturnType<typeof dispatchCleanupWrite> | null>(null)
  const retireView = useRef<(() => void) | null>(null)
  const phase = useSyncExternalStore(
    (listener) => subscribeCleanupWrite(owner, listener),
    () => cleanupWritePhase(owner)
  )
  useLayoutEffect(() => {
    dispatched.current = null
    retireView.current = null
    return () => {
      retireView.current?.()
      void dispatched.current?.retire().catch(() => undefined)
    }
  }, [scopeKey])
  return {
    phase,
    send: (change: WorkspaceCleanupPolicyChange, read: WorkspaceCleanupPolicyRead) => {
      const request = dispatchCleanupWrite(owner, change, read)
      dispatched.current = request
      const retired = Promise.withResolvers<null>()
      retireView.current = () => retired.resolve(null)
      return Promise.race([request.result, retired.promise])
    },
    retry: () => void retryCleanupWrite(owner).catch(() => undefined)
  }
}
