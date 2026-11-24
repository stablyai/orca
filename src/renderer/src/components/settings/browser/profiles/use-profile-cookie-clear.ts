import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useRuntimeHostStatusSelector } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import {
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import { BROWSER_PROFILE_COOKIE_CLEAR_CAPABILITY } from '../../../../../../shared/browser/runtime/browser-runtime-capabilities'
import {
  useConfirmationDialog,
  type ConfirmationDialogContextValue
} from '../../../dismiss/confirmation/confirmation-dialog-context'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { getRuntimeEnvironmentRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'

export type ProfileCookieClearHost = {
  id: ExecutionHostId
  kind: 'local' | 'ssh' | 'runtime'
  label: string
}

/** Settings' Clear cookies for the active profile of the selected host; only the person's click clears. */
export function useProfileCookieClear(
  host: ProfileCookieClearHost,
  profileId: string,
  profileLabel: string
) {
  const t = useTranslate()
  const confirm = useConfirmationDialog()
  const running = useRef(false)
  const [busy, setBusy] = useState(false)
  const lifetime = useRef({ alive: false })
  useEffect(() => {
    const token = { alive: true }
    lifetime.current = token
    return () => {
      token.alive = false
    }
  }, [])
  const parsedHost = parseExecutionHostId(host.id)
  const environmentId = parsedHost?.kind === 'runtime' ? parsedHost.environmentId : null
  const clearsAnyProfile = useRuntimeHostStatusSelector(
    environmentId,
    (entry) =>
      entry?.status?.capabilities?.includes(BROWSER_PROFILE_COOKIE_CLEAR_CAPABILITY) === true
  )
  // An older server clears only Default's cookies.
  const available = host.kind !== 'runtime' || profileId === 'default' || clearsAnyProfile
  const values = { profile: profileLabel, host: host.label }
  const rowText =
    host.kind === 'runtime'
      ? t(
          'browser.profileCookieClear.rowServer',
          'Signs you out of every site in {{profile}} on {{host}}, both in pages on this computer and in streamed pages.',
          values
        )
      : host.kind === 'ssh'
        ? t(
            'browser.profileCookieClear.rowSsh',
            'Signs you out of every site in {{profile}} for {{host}}.',
            values
          )
        : t(
            'browser.profileCookieClear.rowLocal',
            'Signs you out of every site in {{profile}} on this computer.',
            values
          )

  const onClick = async (): Promise<void> => {
    if (running.current || !available) {
      return
    }
    const token = lifetime.current
    // The dialog names this host and profile; a later host switch must not redirect the clear.
    const target = { hostId: host.id, profileId }
    const pairingRevision = environmentId ? getRuntimeEnvironmentRevision(environmentId) : undefined
    running.current = true
    setBusy(true)
    await confirmAndClearProfileCookies({
      target,
      kind: host.kind,
      environmentId,
      pairingRevision,
      values,
      t,
      confirm
    }).catch(() => {})
    running.current = false
    if (token.alive) {
      setBusy(false)
    }
  }
  return { available, busy, rowText, onClick }
}

/** The person confirms the named host and profile, then every store of it is cleared. */
async function confirmAndClearProfileCookies({
  target,
  kind,
  environmentId,
  pairingRevision,
  values,
  t,
  confirm
}: {
  target: { hostId: ExecutionHostId; profileId: string }
  kind: ProfileCookieClearHost['kind']
  environmentId: string | null
  pairingRevision: number | undefined
  values: { profile: string; host: string }
  t: Translate
  confirm: ConfirmationDialogContextValue
}): Promise<void> {
  const local = kind === 'local'
  const accepted = await confirm({
    title: local
      ? t(
          'browser.profileCookieClear.confirmTitleLocal',
          'Clear cookies in {{profile}} on this computer?',
          values
        )
      : t(
          'browser.profileCookieClear.confirmTitle',
          'Clear cookies in {{profile}} on {{host}}?',
          values
        ),
    description:
      kind === 'runtime'
        ? t(
            'browser.profileCookieClear.confirmDescriptionServer',
            'This signs you out of every site in this profile, both in pages on this computer and in streamed pages. Other profiles and hosts keep their cookies.'
          )
        : t(
            'browser.profileCookieClear.confirmDescription',
            'This signs you out of every site in this profile. Other profiles and hosts keep their cookies.'
          ),
    confirmLabel: t('browser.profileCookieClear.clear', 'Clear'),
    cancelLabel: t('browser.profileCookieClear.cancel', 'Cancel'),
    confirmVariant: 'destructive'
  })
  if (!accepted) {
    return
  }
  // Re-paired while the dialog was open: the confirmed server is gone, so nothing is cleared.
  const repaired =
    environmentId !== null && getRuntimeEnvironmentRevision(environmentId) !== pairingRevision
  const ok =
    !repaired &&
    (await useAppStore.getState().clearBrowserProfileCookies({ ...target, pairingRevision }))
  if (ok) {
    toast.success(
      local
        ? t(
            'browser.profileCookieClear.clearedLocal',
            'Cleared cookies in {{profile}} on this computer.',
            values
          )
        : t(
            'browser.profileCookieClear.cleared',
            'Cleared cookies in {{profile}} on {{host}}.',
            values
          )
    )
  } else {
    toast.error(
      local
        ? t(
            'browser.profileCookieClear.failedLocal',
            "Couldn't clear cookies in {{profile}} on this computer. Try again.",
            values
          )
        : t(
            'browser.profileCookieClear.failed',
            "Couldn't clear cookies in {{profile}} on {{host}}. Try again.",
            values
          )
    )
  }
}
