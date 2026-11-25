// The sleeping WSL hosts New bot wakes on its own: at most once each, until the owner re-picks one.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { startWslHostAndReloadProjects } from '@/runtime/hosts/wsl/wsl-host-user-start'
import {
  botWslMayAutoWake,
  botWslShowsWaking,
  botWslWakeAfterStatus,
  botWslWakeSettled,
  botWslWakeTimedOut,
  type BotWslWake,
  type BotWslWakeStep
} from './bot-wsl-wake-policy'

/** A wake main never finishes stops holding Create after this. */
const WAKE_CAP_MS = 90_000
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
  // Read by async answers, which must judge the wakes as they are now, not as they were.
  const current = useRef(wakes)
  const nextToken = useRef(0)
  const statuses = useAppStore((s) => s.wslHostStatuses)

  const apply = useCallback((environmentId: string, step: BotWslWakeStep): void => {
    if (step.toast) {
      toastWakeFailed(environmentId)
    }
    if (step.refresh) {
      // Main finished a wake the connect call gave up on: record the host and reload its projects.
      void startWslHostAndReloadProjects(environmentId, { quiet: true })
    }
    if (step.wake !== current.current.get(environmentId)) {
      current.current = withWake(current.current, environmentId, step.wake)
      setWakes(current.current)
    }
  }, [])

  // Main's state decides how a wake ends once the connect call has given up, and when a failure clears.
  useEffect(() => {
    for (const [environmentId, wake] of current.current) {
      apply(environmentId, botWslWakeAfterStatus(wake, statuses[environmentId]?.state))
    }
  }, [statuses, apply])

  const wake = useCallback(
    (environmentId: string): void => {
      nextToken.current += 1
      const token = nextToken.current
      apply(environmentId, { wake: { phase: 'waking', token }, toast: false })
      const cap = window.setTimeout(
        () => apply(environmentId, botWslWakeTimedOut(current.current.get(environmentId), token)),
        WAKE_CAP_MS
      )
      // The shared start reloads the host's projects too; quiet, since main may still be booting.
      void startWslHostAndReloadProjects(environmentId, { quiet: true }).then((ok) => {
        const state = useAppStore.getState().wslHostStatuses[environmentId]?.state
        const step = botWslWakeSettled(current.current.get(environmentId), token, ok, state)
        if (step.wake?.phase !== 'waking') {
          window.clearTimeout(cap)
        }
        apply(environmentId, step)
      })
    },
    [apply]
  )

  const waking = useMemo(
    () => new Set([...wakes].filter(([, entry]) => botWslShowsWaking(entry)).map(([id]) => id)),
    [wakes]
  )
  return {
    waking,
    mayAutoWake: (environmentId) => botWslMayAutoWake(wakes.get(environmentId)),
    wake,
    forget: (environmentId) => {
      if (current.current.get(environmentId)?.phase === 'failed') {
        apply(environmentId, { wake: undefined, toast: false })
      }
    },
    // A new session: answers for earlier wakes find no attempt of theirs and change nothing.
    reset: () => {
      current.current = NONE
      setWakes(NONE)
    }
  }
}
