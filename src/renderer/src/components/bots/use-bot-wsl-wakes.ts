// The sleeping WSL hosts New bot wakes on its own: at most once each, until the owner re-picks one.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { connectRuntimeEnvironmentAndRecordStatus } from '@/components/status-bar/host-connections/runtime-environment-explicit-connect'
import {
  botWslMayAutoWake,
  botWslShowsWaking,
  botWslWakeAfterStatus,
  botWslWakeSettled,
  type BotWslWake
} from './bot-wsl-wake-policy'

const WAKE_CONNECT_TIMEOUT_MS = 5_000
const NONE: ReadonlyMap<string, BotWslWake> = new Map()

function toastWakeFailed(environmentId: string): void {
  const distro = useAppStore.getState().wslHostStatuses[environmentId]?.distro ?? environmentId
  toast.error(
    translate(
      'components.native-chat.hostOutage.startFailed',
      'Couldn’t start {{distro}}. Check it in Settings → Remote Orca Servers.',
      { distro }
    )
  )
}

function withWake(
  wakes: ReadonlyMap<string, BotWslWake>,
  environmentId: string,
  wake: BotWslWake | undefined
): ReadonlyMap<string, BotWslWake> {
  const next = new Map(wakes)
  if (wake) {
    next.set(environmentId, wake)
  } else {
    next.delete(environmentId)
  }
  return next
}

export function useBotWslWakes(): {
  waking: ReadonlySet<string>
  mayAutoWake: (environmentId: string) => boolean
  wake: (environmentId: string) => void
  /** The owner picked the host again: a failed wake may be tried once more. */
  forget: (environmentId: string) => void
  reset: () => void
} {
  const [wakes, setWakes] = useState(NONE)
  const statuses = useAppStore((s) => s.wslHostStatuses)

  // Main's state decides how a wake ends once the connect call has given up, and when a failure clears.
  useEffect(() => {
    let changed = false
    let next = wakes
    for (const [environmentId, wake] of wakes) {
      const moved = botWslWakeAfterStatus(wake, statuses[environmentId]?.state)
      if (moved.toast) {
        toastWakeFailed(environmentId)
      }
      if (moved.wake !== wake) {
        changed = true
        next = withWake(next, environmentId, moved.wake)
      }
    }
    if (changed) {
      setWakes(next)
    }
  }, [statuses, wakes])

  const wake = useCallback((environmentId: string): void => {
    setWakes((previous) => withWake(previous, environmentId, { phase: 'waking' }))
    void connectRuntimeEnvironmentAndRecordStatus(environmentId, WAKE_CONNECT_TIMEOUT_MS).then(
      (ok) => {
        const settled = botWslWakeSettled(
          ok,
          useAppStore.getState().wslHostStatuses[environmentId]?.state
        )
        if (settled.toast) {
          toastWakeFailed(environmentId)
        }
        setWakes((previous) =>
          previous.has(environmentId) ? withWake(previous, environmentId, settled.wake) : previous
        )
      }
    )
  }, [])

  const waking = useMemo(
    () => new Set([...wakes].filter(([, entry]) => botWslShowsWaking(entry)).map(([id]) => id)),
    [wakes]
  )
  return {
    waking,
    mayAutoWake: (environmentId) => botWslMayAutoWake(wakes.get(environmentId)),
    wake,
    forget: (environmentId) =>
      setWakes((previous) =>
        previous.get(environmentId)?.phase === 'failed'
          ? withWake(previous, environmentId, undefined)
          : previous
      ),
    reset: () => setWakes(NONE)
  }
}
