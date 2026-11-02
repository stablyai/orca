import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { BROWSER_GOOGLE_COOKIE_CLEAR_CAPABILITY } from '../../../shared/browser-runtime-capabilities'
import { useConfirmationDialog } from './confirmation-dialog-context'
import {
  captureGoogleCookieClearTarget,
  confirmAndClearGoogleCookies
} from '@/lib/browser-google-cookie-clear'
import { translate } from '@/i18n/i18n'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'

export function useGoogleCookieClear(hostId: ExecutionHostId, profileId: string, label?: string) {
  const confirm = useConfirmationDialog()
  const running = useRef(false)
  const [busy, setBusy] = useState(false)
  const lifetime = useRef({ alive: false })
  const generation = useRef(0)
  useEffect(() => {
    const token = { alive: true }
    lifetime.current = token
    return () => {
      token.alive = false
    }
  }, [])
  const parsedHost = parseExecutionHostId(hostId)
  const environmentId = parsedHost?.kind === 'runtime' ? parsedHost.environmentId : null
  const revision = useAppStore((s) => {
    const environment = s.runtimeEnvironments.find((entry) => entry.id === environmentId)
    return environment?.pairingRevision ?? environment?.createdAt
  })
  const supported = useAppStore((s) =>
    environmentId
      ? s.runtimeStatusByEnvironmentId
          .get(environmentId)
          ?.status?.capabilities?.includes(BROWSER_GOOGLE_COOKIE_CLEAR_CAPABILITY) === true
      : false
  )
  const [available, setAvailable] = useState<boolean | undefined>()
  useEffect(() => {
    let disposed = false
    const probe = () => {
      const request = ++generation.current
      setAvailable(undefined)
      void captureGoogleCookieClearTarget(hostId, profileId, label, false)
        .catch(() => ({ available: false }))
        .then((next) => {
          if (!disposed && generation.current === request) {
            setAvailable(next.available)
          }
        })
    }
    const unsubscribe = window.api.browser.onSessionProfilesChanged(probe)
    probe()
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [hostId, profileId, label, revision, supported])

  const onClick = async (): Promise<void> => {
    if (running.current) {
      return
    }
    const token = lifetime.current
    const request = generation.current
    const pairingRevision = environmentId ? getRuntimeEnvironmentRevision(environmentId) : undefined
    let dialogOpened = false
    running.current = true
    setBusy(true)
    try {
      const captured = await captureGoogleCookieClearTarget(
        hostId,
        profileId,
        label,
        true,
        pairingRevision
      )
      if (!token.alive) {
        return
      }
      if (!captured.available) {
        if (generation.current === request) {
          generation.current++
          setAvailable(false)
        }
        return
      }
      if (!captured.target) {
        throw new Error('Google cookie target unavailable')
      }
      await confirmAndClearGoogleCookies(captured.target, async (options) => {
        dialogOpened = true
        const accepted = await confirm(options)
        if (
          accepted &&
          environmentId &&
          getRuntimeEnvironmentRevision(environmentId) !== pairingRevision
        ) {
          throw new Error('Google cookie destination changed')
        }
        return accepted
      })
    } catch {
      if (!token.alive && !dialogOpened) {
        return
      }
      toast.error(
        translate(
          'browser.googleCookieClear.unverified',
          "Couldn't check {{profile}}'s Google cookies. Try again.",
          { profile: label || (profileId === 'default' ? 'Default' : 'Browser profile') }
        )
      )
    } finally {
      running.current = false
      if (token.alive) {
        setBusy(false)
      }
    }
  }
  return { available, busy, onClick }
}
