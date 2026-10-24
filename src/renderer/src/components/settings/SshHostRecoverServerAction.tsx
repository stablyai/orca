import { Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { OrcadManagedStaleLockReclaimResult } from '../../../../shared/orcad-managed-runtime'
import {
  ORCAD_RECLAIM_STALE_LOCK_FLAG,
  type OrcadStaleLockEvidence
} from '../../../../shared/orcad-stale-lock-reclaim'
import type { SshManagedServerStatus } from '../../../../shared/ssh-types'
import type { ManagedOrcadPreloadApi } from '../../../../preload/api/managed-orcad-api'
import { quotePosixShellUnlessPlain } from '../../../../shared/shell-argument-quoting'
import { useMountedRef } from '@/hooks/useMountedRef'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Label } from '../ui/label'
import { getManagedOrcadApi } from './use-managed-server-catalog'

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

/**
 * Clears a managed server's instance lock that a start refused because another machine sharing
 * the home may hold it (#32177). The host checks first; only the user can rule that machine out.
 */
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
  // Mounted per opening, so each one starts from a fresh check.
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
  // Frozen at opening: the reclaim itself clears the note that offered it, and a later status
  // push must neither close the dialog nor hide the result the user is reading.
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

  useEffect(() => {
    if (!opened) {
      return
    }
    api.reclaimStaleLock({ selector: opened.environmentId, yes: false }).then(
      (next) => mountedRef.current && setCheck(next),
      (cause: unknown) => mountedRef.current && setError(messageOf(cause))
    )
  }, [api, mountedRef, opened])

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
      // A cleared lock ends the flow: its evidence and the confirmation no longer apply.
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
  // The confirmation is pinned to the record the user saw; without its nonce there is none to pin.
  const approvedNonce = eligible ? check.evidence?.nonce : undefined
  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onOpenChange(false)}>
      <DialogContent surface="security" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.settings.recoverServer.title', 'Recover Orca’s server')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.recoverServer.description',
              'Orca’s server on this host won’t start because a lock from an earlier run is still in place.'
            )}
          </DialogDescription>
        </DialogHeader>
        {!check && !error ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {translate('auto.components.settings.recoverServer.checking', 'Checking the lock…')}
          </p>
        ) : null}
        {eligible ? <EligibleLock evidence={check.evidence} /> : null}
        {eligible ? (
          <div className="flex items-center gap-2">
            <Checkbox
              id="ssh-host-recover-server-confirm"
              checked={confirmed}
              disabled={busy}
              onCheckedChange={(next) => setConfirmed(next === true)}
            />
            <Label htmlFor="ssh-host-recover-server-confirm">
              {translate(
                'auto.components.settings.recoverServer.confirmCheck',
                'No other machine sharing this home is running Orca'
              )}
            </Label>
          </div>
        ) : null}
        {check && !eligible ? <CheckOutcome check={check} detail={detail} /> : null}
        {error ? (
          <div className="space-y-2 text-sm">
            <p className="text-destructive">{error}</p>
            <ManualReclaim detail={detail} />
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {check?.status === 'reclaimed'
              ? translate('auto.components.settings.recoverServer.close', 'Close')
              : translate('auto.components.settings.recoverServer.cancel', 'Cancel')}
          </Button>
          {eligible ? (
            <Button
              onClick={() => approvedNonce && void reclaim(approvedNonce)}
              disabled={busy || !confirmed || !approvedNonce}
            >
              {translate(
                'auto.components.settings.recoverServer.confirm',
                'Clear lock and restart'
              )}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EligibleLock({
  evidence
}: {
  evidence: OrcadStaleLockEvidence | undefined
}): React.JSX.Element {
  return (
    <div className="space-y-2 text-sm">
      <p>
        {translate(
          'auto.components.settings.recoverServer.eligible',
          'Nothing answers on this machine at its old address, but Orca can’t rule out another machine with the same name that shares this home folder.'
        )}
      </p>
      {evidence ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">
            {translate('auto.components.settings.recoverServer.host', 'Host')}
          </dt>
          <dd className="font-mono">{evidence.host}</dd>
          <dt className="text-muted-foreground">
            {translate('auto.components.settings.recoverServer.lockBoot', 'Written during boot')}
          </dt>
          <dd className="font-mono break-all">{evidence.bootId}</dd>
          <dt className="text-muted-foreground">
            {translate('auto.components.settings.recoverServer.currentBoot', 'Current boot')}
          </dt>
          <dd className="font-mono break-all">{evidence.currentBootId}</dd>
          <dt className="text-muted-foreground">
            {translate('auto.components.settings.recoverServer.written', 'Written')}
          </dt>
          <dd>{formatUiRelativeTime(-evidence.ageMinutes * 60_000)}</dd>
        </dl>
      ) : null}
      <p className="font-medium text-status-warning">
        {translate(
          'auto.components.settings.recoverServer.warning',
          'Only continue if no other machine sharing this home runs Orca for this profile.'
        )}
      </p>
    </div>
  )
}

function CheckOutcome({
  check,
  detail
}: {
  check: OrcadManagedStaleLockReclaimResult
  detail: string
}): React.JSX.Element {
  if (check.status === 'reclaimed') {
    // The lock is gone, so neither the reclaim command nor a delete by hand applies.
    return (
      <div className="space-y-2 text-sm">
        <p>
          {translate(
            'auto.components.settings.recoverServer.reclaimedNotStarted',
            'The lock was cleared, but Orca’s server did not start.'
          )}
        </p>
        {check.notRestarted ? <p className="text-destructive">{check.notRestarted}</p> : null}
      </div>
    )
  }
  if (check.status === 'none') {
    return (
      <p className="text-sm text-muted-foreground">
        {translate(
          'auto.components.settings.recoverServer.none',
          'There is no lock to clear any more. Reconnect to start this host’s Orca server.'
        )}
      </p>
    )
  }
  return (
    <div className="space-y-2 text-sm">
      <p className="text-destructive">{check.message}</p>
      {check.status === 'refused' || check.status === 'no-answer' ? (
        <ManualReclaim detail={detail} />
      ) : null}
      {/* Its orcad's own reclaim is safer than a delete; only a host without one gets rm. */}
      {check.status === 'unsupported' ? (
        check.reclaimWithoutPin ? (
          <ManualReclaim detail={detail} />
        ) : (
          <ManualLockDelete lockPath={check.lockPath} />
        )
      ) : null}
    </div>
  )
}

function ManualReclaim({ detail }: { detail: string }): React.JSX.Element {
  const command = staleLockReclaimCommandFrom(detail)
  if (!command) {
    return <ManualLockDelete lockPath={undefined} />
  }
  return (
    <div className="space-y-1.5">
      <p className="text-muted-foreground">
        {translate(
          'auto.components.settings.recoverServer.manualCommand',
          'Run this on the host, or delete the lock file shown in Details:'
        )}
      </p>
      <LiteralCommand command={command} />
    </div>
  )
}

function ManualLockDelete({ lockPath }: { lockPath: string | undefined }): React.JSX.Element {
  if (!lockPath) {
    return (
      <p className="text-muted-foreground">
        {translate(
          'auto.components.settings.recoverServer.manualDelete',
          'Delete the lock file shown in Details once you are sure no other machine uses it.'
        )}
      </p>
    )
  }
  return (
    <div className="space-y-1.5">
      <p className="text-muted-foreground">
        {translate(
          'auto.components.settings.recoverServer.manualDeleteCommand',
          'Delete the lock on the host by hand:'
        )}
      </p>
      <LiteralCommand command={`rm ${quotePosixShellUnlessPlain(lockPath)}`} />
      <p className="font-medium text-status-warning">
        {translate(
          'auto.components.settings.recoverServer.manualDeleteWarning',
          'Only do this if no other machine sharing this home runs Orca for this profile.'
        )}
      </p>
    </div>
  )
}

function LiteralCommand({ command }: { command: string }): React.JSX.Element {
  return (
    <pre className="whitespace-pre-wrap break-all rounded-md border border-border bg-background px-3 py-2 font-mono text-2xs leading-relaxed text-muted-foreground select-text">
      {command}
    </pre>
  )
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
