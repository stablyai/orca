import { Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { OrcadManagedStaleLockReclaimResult } from '../../../../../../shared/remote-runtime/orcad-lifecycle/orcad-managed-runtime'
import {
  ORCAD_RECLAIM_STALE_LOCK_FLAG,
  type OrcadStaleLockEvidence
} from '../../../../../../shared/remote-runtime/orcad-lifecycle/orcad-stale-lock-reclaim'
import type { SshManagedServerStatus } from '../../../../../../shared/remote-runtime/ssh/ssh-types'
import type { ManagedOrcadPreloadApi } from '../../../../../../preload/api/runtime/managed-orcad-api'
import { quotePosixShellUnlessPlain } from '../../../../../../shared/shell/launch/shell-argument-quoting'
import { useMountedRef } from '@/hooks/useMountedRef'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { Button } from '../../../ui/button'
import { Checkbox } from '../../../ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../../ui/dialog'
import {
  DialogCancel,
  DialogDisclosure,
  DialogError,
  DialogWarning
} from '../../../ui/dialog-parts'
import { Label } from '../../../ui/label'
import { getManagedOrcadApi } from '../../../../runtime/hosts/installation/managed-orcad-api-availability'

/** Offered only when the slot's own refusal named the command, so that build supports it. */
export function canRecoverSshHostServer(status: SshManagedServerStatus | undefined): boolean {
  return Boolean(
    getManagedOrcadApi() &&
    status?.kind === 'managed' &&
    status.serving?.state === 'unverifiable' &&
    status.serving.detail.includes(ORCAD_RECLAIM_STALE_LOCK_FLAG)
  )
}

/** The command the refusal names, for the user to run on the host by hand. */
export function staleLockReclaimCommandFrom(detail: string): string | null {
  return (
    detail
      .match(/`([^`]*)`/g)
      ?.find((quoted) => quoted.includes(ORCAD_RECLAIM_STALE_LOCK_FLAG))
      ?.slice(1, -1) ?? null
  )
}

/** Reclaim refused instance locks after host checks; only the user can exclude another machine sharing the home (#32177). */
export function SshHostRecoverServerDialog({
  status,
  open,
  onOpenChange,
  onChanged
}: {
  status: SshManagedServerStatus | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanged: () => void
}): React.JSX.Element | null {
  const api = getManagedOrcadApi()
  if (!api || !open) {
    return null
  }
  return (
    <OpenRecoverServerDialog
      api={api}
      status={status}
      onOpenChange={onOpenChange}
      onChanged={onChanged}
    />
  )
}

function OpenRecoverServerDialog({
  api,
  status,
  onOpenChange,
  onChanged
}: {
  api: ManagedOrcadPreloadApi
  status: SshManagedServerStatus | undefined
  onOpenChange: (open: boolean) => void
  onChanged: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  // Freeze opening context: reclaim clears its own refusal, but status pushes must preserve the dialog and result.
  const [opened] = useState(() =>
    status?.kind === 'managed'
      ? { environmentId: status.environmentId, detail: status.serving?.detail ?? '' }
      : null
  )
  const mountedRef = useMountedRef()
  const [check, setCheck] = useState<OrcadManagedStaleLockReclaimResult | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checkAttempt, setCheckAttempt] = useState(0)

  useEffect(() => {
    if (!opened) {
      return
    }
    api.reclaimStaleLock({ selector: opened.environmentId, yes: false }).then(
      (next) => mountedRef.current && setCheck(next),
      (cause: unknown) => mountedRef.current && setError(messageOf(cause))
    )
  }, [api, mountedRef, opened, checkAttempt])
  const checkAgain = (): void => {
    setCheck(null)
    setError(null)
    setConfirmed(false)
    setCheckAttempt((attempt) => attempt + 1)
  }

  if (!opened) {
    return null
  }
  const { environmentId, detail } = opened
  const reclaim = async (expectNonce: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.reclaimStaleLock({ selector: environmentId, yes: true, expectNonce })
      if (!mountedRef.current) {
        return
      }
      if (result.status === 'reclaimed') {
        onChanged()
        if (!result.notRestarted) {
          onOpenChange(false)
          return
        }
      }
      setCheck(result)
    } catch (cause) {
      if (mountedRef.current) {
        setError(messageOf(cause))
      }
    } finally {
      if (mountedRef.current) {
        setBusy(false)
      }
    }
  }
  const eligible = check?.status === 'eligible'
  // Pin confirmation to the evidence nonce the user reviewed.
  const approvedNonce = eligible ? check.evidence?.nonce : undefined
  const host = eligible ? check.evidence?.host : undefined
  return (
    <Dialog open onOpenChange={(next) => !next && onOpenChange(false)}>
      <DialogContent size="confirm" surface="security" busy={busy} initialFocus="cancel" scrollable>
        <DialogHeader>
          <DialogTitle>
            {host
              ? t(
                  'components.settings.recoverServer.titleOnHost',
                  'Clear the old lock on {{host}}?',
                  {
                    host
                  }
                )
              : t('components.settings.recoverServer.titleGeneric', 'Clear the old lock?')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'components.settings.recoverServer.summary',
              'An earlier run left a lock, so Orca’s server can’t start.'
            )}
          </DialogDescription>
        </DialogHeader>
        {!check && !error ? (
          <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {t('auto.components.settings.recoverServer.checking', 'Checking the lock…')}
          </p>
        ) : null}
        {eligible ? (
          <div className="flex items-start gap-2">
            <Checkbox
              id="ssh-host-recover-server-confirm"
              className="mt-0.5"
              checked={confirmed}
              disabled={busy}
              onCheckedChange={(next) => setConfirmed(next === true)}
            />
            <Label htmlFor="ssh-host-recover-server-confirm" variant="dialog">
              {t(
                'components.settings.recoverServer.confirmCheckHomeFolder',
                'No other machine sharing this home folder is running Orca'
              )}
            </Label>
          </div>
        ) : null}
        {eligible && check.evidence && !error ? <EligibleLock evidence={check.evidence} /> : null}
        {check && !eligible ? <CheckOutcome check={check} detail={detail} /> : null}
        {error ? (
          <>
            <DialogError onRetry={eligible ? undefined : checkAgain}>{error}</DialogError>
            {/* Why one disclosure: the lock evidence and the manual fallback read as one set of details. */}
            <DialogDisclosure label={t('components.settings.recoverServer.details', 'Details')}>
              <div className="space-y-2">
                {eligible && check.evidence ? <LockEvidence evidence={check.evidence} /> : null}
                <ManualReclaim detail={detail} />
              </div>
            </DialogDisclosure>
          </>
        ) : null}
        <DialogFooter>
          <DialogCancel>
            {check?.status === 'reclaimed'
              ? t('auto.components.settings.recoverServer.close', 'Close')
              : t('auto.components.settings.recoverServer.cancel', 'Cancel')}
          </DialogCancel>
          {eligible ? (
            <Button
              size="sm"
              onClick={() => approvedNonce && void reclaim(approvedNonce)}
              disabled={busy || !confirmed || !approvedNonce}
            >
              {busy
                ? t('components.settings.recoverServer.clearing', 'Clearing…')
                : t('auto.components.settings.recoverServer.confirm', 'Clear lock & restart')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EligibleLock({ evidence }: { evidence: OrcadStaleLockEvidence }): React.JSX.Element {
  const t = useTranslate()
  return (
    <DialogDisclosure label={t('components.settings.recoverServer.details', 'Details')}>
      <LockEvidence evidence={evidence} />
    </DialogDisclosure>
  )
}

function LockEvidence({ evidence }: { evidence: OrcadStaleLockEvidence }): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
      <dt>{t('auto.components.settings.recoverServer.host', 'Host')}</dt>
      <dd className="font-mono text-foreground">{evidence.host}</dd>
      <dt>{t('auto.components.settings.recoverServer.lockBoot', 'Written during boot')}</dt>
      <dd className="font-mono break-all text-foreground">{evidence.bootId}</dd>
      <dt>{t('auto.components.settings.recoverServer.currentBoot', 'Current boot')}</dt>
      <dd className="font-mono break-all text-foreground">{evidence.currentBootId}</dd>
      <dt>{t('auto.components.settings.recoverServer.written', 'Written')}</dt>
      <dd className="text-foreground">
        {formatUiRelativeTime(-evidence.ageMinutes * 60_000, intlLocale)}
      </dd>
    </dl>
  )
}

function CheckOutcome({
  check,
  detail
}: {
  check: OrcadManagedStaleLockReclaimResult
  detail: string
}): React.JSX.Element {
  const t = useTranslate()
  if (check.status === 'reclaimed') {
    return (
      <>
        <p className="text-[13px]">
          {t(
            'auto.components.settings.recoverServer.reclaimedNotStarted',
            'The lock was cleared, but Orca’s server did not start.'
          )}
        </p>
        {check.notRestarted ? <DialogError>{check.notRestarted}</DialogError> : null}
      </>
    )
  }
  if (check.status === 'none') {
    return (
      <p className="text-[13px] text-muted-foreground">
        {t(
          'auto.components.settings.recoverServer.none',
          'There is no lock to clear any more. Reconnect to start this host’s Orca server.'
        )}
      </p>
    )
  }
  // Prefer the host’s own reclaim command; offer rm only when unsupported.
  const manual =
    check.status === 'refused' ||
    check.status === 'no-answer' ||
    (check.status === 'unsupported' && check.reclaimWithoutPin) ? (
      <ManualReclaim detail={detail} />
    ) : check.status === 'unsupported' ? (
      <ManualLockDelete lockPath={check.lockPath} />
    ) : null
  return (
    <>
      <DialogError>{check.message}</DialogError>
      {manual ? (
        <DialogDisclosure label={t('components.settings.recoverServer.details', 'Details')}>
          {manual}
        </DialogDisclosure>
      ) : null}
    </>
  )
}

function ManualReclaim({ detail }: { detail: string }): React.JSX.Element {
  const t = useTranslate()
  const command = staleLockReclaimCommandFrom(detail)
  if (!command) {
    return <ManualLockDelete lockPath={undefined} />
  }
  return (
    <div className="space-y-1.5">
      <p>
        {t(
          'auto.components.settings.recoverServer.manualCommand',
          'Run this on the host, or delete the lock file shown in Details:'
        )}
      </p>
      <LiteralCommand command={command} />
    </div>
  )
}

function ManualLockDelete({ lockPath }: { lockPath: string | undefined }): React.JSX.Element {
  const t = useTranslate()
  if (!lockPath) {
    return (
      <p>
        {t(
          'auto.components.settings.recoverServer.manualDelete',
          'Delete the lock file shown in Details once you are sure no other machine uses it.'
        )}
      </p>
    )
  }
  return (
    <div className="space-y-1.5">
      <p>
        {t(
          'auto.components.settings.recoverServer.manualDeleteCommand',
          'Delete the lock on the host by hand:'
        )}
      </p>
      <LiteralCommand command={`rm ${quotePosixShellUnlessPlain(lockPath)}`} />
      <DialogWarning>
        {t(
          'auto.components.settings.recoverServer.manualDeleteWarning',
          'Only do this if no other machine sharing this home runs Orca for this profile.'
        )}
      </DialogWarning>
    </div>
  )
}

function LiteralCommand({ command }: { command: string }): React.JSX.Element {
  return (
    <pre className="font-mono whitespace-pre-wrap break-all text-foreground select-text">
      {command}
    </pre>
  )
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
