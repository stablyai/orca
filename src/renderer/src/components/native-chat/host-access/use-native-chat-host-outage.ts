import { useCallback, useContext, useMemo, useState, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { useNativeChatPaneLifetimeEffect } from '../pane/ownership/native-chat-pane-lifetime'
import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host'
import { runtimeHostContactFromSnapshot } from '../../../../../shared/remote-runtime/host-status/runtime-host-contact'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { runtimeHostConnectionStateForEntry } from '@/runtime/hosts/connections/runtime-host-connection-state'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

import { NativeChatHostOutageContext } from './native-chat-host-outage-owner'
import {
  createNativeChatHostOutageLatch,
  nativeChatHostOutageKind,
  type NativeChatHostOutage
} from './native-chat-host-outage-latch'
export {
  nativeChatHostOutageKind,
  NATIVE_CHAT_HOST_RECONNECTING_GRACE_MS
} from './native-chat-host-outage-latch'
export type {
  NativeChatHostOutage,
  NativeChatHostOutageKind
} from './native-chat-host-outage-latch'

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
  const stoppedDistro = useAppStore((s) => {
    const wsl = environmentId === null ? undefined : s.wslHostStatuses[environmentId]
    return wsl?.state === 'distro-stopped' ? wsl.distro : null
  })
  const hostLabel = useAppStore((s) =>
    environmentId === null
      ? null
      : selectExecutionHostDisplayLabel(s, toRuntimeExecutionHostId(environmentId))
  )
  const retainedLatch = useContext(NativeChatHostOutageContext)
  const [fallbackLatch] = useState(() => retainedLatch ?? createNativeChatHostOutageLatch())
  const latch = retainedLatch ?? fallbackLatch
  useNativeChatPaneLifetimeEffect(
    useCallback(
      () => (retainedLatch || environmentId === null ? undefined : latch.track(environmentId)),
      [environmentId, latch, retainedLatch]
    )
  )
  const earned = useSyncExternalStore(latch.subscribe, latch.read, latch.read)
  const earnedHere = earned?.environmentId === environmentId ? earned.kind : null
  const shown = kind === 'offline' ? 'offline' : kind === null ? null : earnedHere
  return useMemo(() => {
    if (environmentId === null) {
      return null
    }
    // The host's own verdict outranks a transport guess: a plain reconnect can't boot the distro.
    if (stoppedDistro !== null) {
      return { kind: 'stopped', environmentId, hostLabel: stoppedDistro, canReconnect: true }
    }
    return shown === null || hostLabel === null
      ? null
      : { kind: shown, environmentId, hostLabel, canReconnect: shown === 'offline' && !refused }
  }, [environmentId, hostLabel, refused, shown, stoppedDistro])
}
