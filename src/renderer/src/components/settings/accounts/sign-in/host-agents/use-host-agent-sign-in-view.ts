import { useCallback, useEffect, useSyncExternalStore } from 'react'
import {
  ensureHostAgentSignInStatus,
  readHostAgentSignInStatus,
  subscribeHostAgentSignInStatus,
  type HostAgentSignInView
} from '@/runtime/provider-accounts/sign-in/host-agent-sign-in-status-client'

const IDLE: HostAgentSignInView = { phase: 'idle' }

/** The host's agent sign-in, asked once per TTL while `enabled` (the host is reachable and awake). */
export function useHostAgentSignInView(
  environmentId: string,
  enabled: boolean
): HostAgentSignInView {
  const read = useCallback(() => readHostAgentSignInStatus(environmentId), [environmentId])
  const view = useSyncExternalStore(subscribeHostAgentSignInStatus, read, read)
  useEffect(() => {
    if (enabled) {
      ensureHostAgentSignInStatus(environmentId)
    }
  }, [enabled, environmentId])
  return enabled ? view : IDLE
}
