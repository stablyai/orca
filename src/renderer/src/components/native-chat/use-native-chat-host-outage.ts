import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { runtimeHostContactFromSnapshot } from '../../../../shared/runtime-host-contact'
import { selectExecutionHostDisplayLabel } from '@/lib/execution-host-display-label'
import {
  runtimeHostConnectionStateForEntry,
  type RuntimeHostConnectionState
} from '@/runtime/runtime-host-connection-state'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

export type NativeChatHostOutageKind = 'reconnecting' | 'offline'

export type NativeChatHostOutage = {
  kind: NativeChatHostOutageKind
  environmentId: string
  hostLabel: string
  /** Auth/protocol refusals would also reject reconnection. */
  canReconnect: boolean
}

/** Suppress brief reconnect blips; show offline hosts immediately. */
export const NATIVE_CHAT_HOST_RECONNECTING_GRACE_MS = 2_000

export function nativeChatHostOutageKind(
  state: RuntimeHostConnectionState
): NativeChatHostOutageKind | null {
  // A closed workspace window still answers requests that do not need that window.
  switch (state) {
    case 'connected':
    case 'workspace-window-closed':
      return null
    // These states have no automatic transport recovery.
    case 'disconnected':
      return 'offline'
    // runtime-unavailable also precedes the probe on every recovery.
    case 'checking':
    case 'reconnecting':
    case 'runtime-unavailable':
      return 'reconnecting'
  }
}

/** Use host connection state; the chat stream cannot establish host availability. */
export function useNativeChatHostOutage(target: RuntimeClientTarget): NativeChatHostOutage | null {
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const kind = useAppStore((s) =>
    environmentId === null
      ? null
      : nativeChatHostOutageKind(
          runtimeHostConnectionStateForEntry(s.runtimeStatusByEnvironmentId.get(environmentId))
        )
  )
  const refused = useAppStore((s) => {
    const entry = environmentId === null ? null : s.runtimeStatusByEnvironmentId.get(environmentId)
    return entry?.snapshot
      ? runtimeHostContactFromSnapshot(entry.snapshot, entry.status).verdict === 'refused'
      : false
  })
  const hostLabel = useAppStore((s) =>
    environmentId === null
      ? null
      : selectExecutionHostDisplayLabel(s, toRuntimeExecutionHostId(environmentId))
  )
  // Reset earned outage visibility when this outage or host changes.
  const [earned, setEarned] = useState<{
    environmentId: string
    kind: NativeChatHostOutageKind
  } | null>(null)
  const earnedHere = earned?.environmentId === environmentId ? earned.kind : null
  // Latch offline until recovery so retry probes cannot flicker the notice.
  if (kind === 'offline' && environmentId !== null && earnedHere !== 'offline') {
    setEarned({ environmentId, kind: 'offline' })
  }
  const inOutage = kind !== null
  useEffect(() => {
    if (environmentId === null || !inOutage) {
      return
    }
    const timer = setTimeout(() => {
      setEarned((current) =>
        current?.environmentId === environmentId ? current : { environmentId, kind: 'reconnecting' }
      )
    }, NATIVE_CHAT_HOST_RECONNECTING_GRACE_MS)
    return () => {
      clearTimeout(timer)
      setEarned((current) => (current?.environmentId === environmentId ? null : current))
    }
  }, [environmentId, inOutage])
  const shown = kind === 'offline' ? 'offline' : kind === null ? null : earnedHere
  return useMemo(
    () =>
      environmentId === null || shown === null || hostLabel === null
        ? null
        : { kind: shown, environmentId, hostLabel, canReconnect: shown === 'offline' && !refused },
    [environmentId, hostLabel, refused, shown]
  )
}
