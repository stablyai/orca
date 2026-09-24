import React, { useCallback, useState } from 'react'
import { CircleCheck, CircleDashed, LoaderCircle } from 'lucide-react'
import type { PtyManagementFolderAccessMismatch } from '../../../../preload/api-types'
import { isMacTccFolderClass } from '../../../../shared/daemon-adoption-telemetry'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { track } from '@/lib/telemetry'
import { useMacFolderAccessFixStore } from '@/store/mac-folder-access-fix'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { macFolderAccessFolderName } from './mac-folder-access-folder-name'

const FILES_AND_FOLDERS_PANE = { id: 'files-and-folders' } as const

type RestartState = 'idle' | 'busy' | 'done' | 'failed'
/** 'probed': the reset ran and a fresh probe answered; the verdict itself is on the mismatch. */
type ResetState = 'idle' | 'busy' | 'probed' | 'failed'

function Step({
  done,
  label,
  helper
}: {
  done: boolean
  label: string
  helper?: string
}): React.JSX.Element {
  return (
    <li className="flex items-start gap-2">
      {done ? (
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-status-success" aria-hidden="true" />
      ) : (
        <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm text-foreground">{label}</span>
        {helper ? <span className="text-xs text-muted-foreground">{helper}</span> : null}
      </div>
    </li>
  )
}

/**
 * Whether the denial is one `tccutil reset` can act on: only Documents, Desktop and Downloads have
 * a per-app TCC row, so offering the button for any other folder promises a remedy that cannot run.
 */
function canResetPermission(mismatch: PtyManagementFolderAccessMismatch): boolean {
  return mismatch.freshDaemonAccess === 'denied' && isMacTccFolderClass(mismatch.cwdClass)
}

function allowStepHelper(mismatch: PtyManagementFolderAccessMismatch): string | undefined {
  // A probe that could not answer must not accuse the user of a missing grant.
  if (mismatch.freshDaemonAccess === 'unknown') {
    return translate(
      'auto.components.shared.MacFolderAccessFixDialog.stepAllowUnknown',
      'Couldn’t verify. Skip if already allowed.'
    )
  }
  // The toggle is already on for everyone who sees this, so the step has to say what the reset
  // does instead of pointing at a switch (STA-7948). Without a reset there is nothing to promise.
  if (canResetPermission(mismatch)) {
    return translate(
      'auto.components.shared.MacFolderAccessFixDialog.stepAllowDenied',
      'Orca is already allowed, but macOS isn’t applying it to the terminal service. Reset asks macOS for the permission again. Click Allow when it prompts.'
    )
  }
  return undefined
}

function FixSteps({
  mismatch,
  restartState,
  resetState,
  folder
}: {
  mismatch: PtyManagementFolderAccessMismatch
  restartState: RestartState
  resetState: ResetState
  folder: string
}): React.JSX.Element {
  return (
    <>
      <ol className="flex flex-col gap-3">
        <Step
          done={mismatch.freshDaemonAccess === 'allowed' || restartState === 'done'}
          label={
            canResetPermission(mismatch)
              ? translate(
                  'auto.components.shared.MacFolderAccessFixDialog.stepReallow',
                  'Re-allow Orca for your {{folder}}',
                  { folder }
                )
              : translate(
                  'auto.components.shared.MacFolderAccessFixDialog.stepAllow',
                  'Allow Orca under Files and Folders'
                )
          }
          helper={restartState === 'done' ? undefined : allowStepHelper(mismatch)}
        />
        <Step
          done={restartState === 'done'}
          label={translate(
            'auto.components.shared.MacFolderAccessFixDialog.stepRestart',
            'Restart Orca’s terminal service'
          )}
          helper={
            restartState === 'done'
              ? undefined
              : translate(
                  'auto.components.shared.MacFolderAccessFixDialog.restartConsequence',
                  'Open terminals and agents will restart.'
                )
          }
        />
      </ol>
      {restartState === 'failed' ? (
        <p className="text-sm text-destructive">
          {translate(
            'auto.components.shared.MacFolderAccessFixDialog.restartFailed',
            'Restart failed. Try again from Settings → Terminal → Manage Sessions.'
          )}
        </p>
      ) : null}
      {resetState === 'failed' && mismatch.freshDaemonAccess !== 'allowed' ? (
        <p className="text-sm text-destructive">
          {translate(
            'auto.components.shared.MacFolderAccessFixDialog.resetFailed',
            'Couldn’t reset the permission. Use System Settings instead.'
          )}
        </p>
      ) : null}
      {resetState === 'probed' && mismatch.freshDaemonAccess === 'denied' ? (
        <p className="text-sm text-muted-foreground">
          {translate(
            'auto.components.shared.MacFolderAccessFixDialog.resetStillBlocked',
            'Still blocked after the reset.'
          )}
        </p>
      ) : null}
    </>
  )
}

/** The footer carries the active step's one action, so the steps stay a checklist. */
function FixFooter({
  mismatch,
  restartState,
  resetState,
  onCancel,
  onOpenSettings,
  onReset,
  onRestart
}: {
  mismatch: PtyManagementFolderAccessMismatch
  restartState: RestartState
  resetState: ResetState
  onCancel: () => void
  onOpenSettings: () => void
  onReset: () => void
  onRestart: () => void
}): React.JSX.Element {
  const busy = restartState === 'busy' || resetState === 'busy'
  const openSettingsLabel = translate(
    'auto.components.shared.MacFolderAccessFixDialog.openSystemSettings',
    'Open System Settings'
  )
  if (restartState === 'done') {
    return (
      <Button size="sm" onClick={onCancel}>
        {translate('auto.components.shared.MacFolderAccessFixDialog.done', 'Done')}
      </Button>
    )
  }
  // Restarting cannot help while a fresh daemon is denied, so the reset takes the primary slot.
  // Two routes for one step would read as a choice the user cannot make.
  if (canResetPermission(mismatch)) {
    // System Settings is the fallback: it appears only once the reset has settled without helping.
    const resetSettled = resetState === 'probed' || resetState === 'failed'
    return (
      <>
        {resetSettled ? (
          <Button variant="ghost" size="sm" onClick={onOpenSettings} disabled={busy}>
            {openSettingsLabel}
          </Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            {translate('auto.components.shared.MacFolderAccessFixDialog.cancel', 'Cancel')}
          </Button>
        )}
        <Button size="sm" onClick={onReset} disabled={busy}>
          {resetState === 'busy' ? <LoaderCircle className="size-4 animate-spin" /> : null}
          {resetState === 'busy'
            ? translate('auto.components.shared.MacFolderAccessFixDialog.resetting', 'Resetting…')
            : translate(
                'auto.components.shared.MacFolderAccessFixDialog.reset',
                'Reset permission'
              )}
        </Button>
      </>
    )
  }
  // A denial with no TCC row to reset leaves System Settings as the only route, so it takes the
  // primary slot: a restart cannot help while a fresh daemon is denied.
  if (mismatch.freshDaemonAccess === 'denied') {
    return (
      <>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          {translate('auto.components.shared.MacFolderAccessFixDialog.cancel', 'Cancel')}
        </Button>
        <Button size="sm" onClick={onOpenSettings} disabled={busy}>
          {openSettingsLabel}
        </Button>
      </>
    )
  }
  return (
    <>
      {mismatch.freshDaemonAccess === 'unknown' ? (
        <Button variant="ghost" size="sm" onClick={onOpenSettings} disabled={busy}>
          {openSettingsLabel}
        </Button>
      ) : (
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          {translate('auto.components.shared.MacFolderAccessFixDialog.cancel', 'Cancel')}
        </Button>
      )}
      <Button size="sm" onClick={onRestart} disabled={busy}>
        {restartState === 'busy' ? <LoaderCircle className="size-4 animate-spin" /> : null}
        {restartState === 'busy'
          ? translate('auto.components.shared.MacFolderAccessFixDialog.restarting', 'Restarting…')
          : translate('auto.components.shared.MacFolderAccessFixDialog.restart', 'Restart')}
      </Button>
    </>
  )
}

/**
 * The remedy for a daemon macOS refuses a folder to (STA-7948), raised from the folder-access
 * toast. Two steps, because a restart alone only works once Orca itself is allowed again — which
 * step 1 does, and the focus-time poll behind `freshDaemonAccess` is what notices it landed.
 */
function FolderAccessFix({
  mismatch
}: {
  mismatch: PtyManagementFolderAccessMismatch
}): React.JSX.Element {
  const close = useMacFolderAccessFixStore((s) => s.close)
  const applyVerdict = useMacFolderAccessFixStore((s) => s.applyVerdict)
  const retireNotice = useMacFolderAccessFixStore((s) => s.retireNotice)
  const [restartState, setRestartState] = useState<RestartState>('idle')
  const [resetState, setResetState] = useState<ResetState>('idle')
  const mountedRef = useMountedRef()
  const { cwdClass, daemonScope } = mismatch

  const onOpenSettings = useCallback((): void => {
    track('daemon_folder_access_notice', { action: 'settings_opened', cwd_class: cwdClass })
    void window.api?.developerPermissions?.openSettings(FILES_AND_FOLDERS_PANE)
  }, [cwdClass])

  const onReset = useCallback(async (): Promise<void> => {
    track('daemon_folder_access_notice', { action: 'reset_clicked', cwd_class: cwdClass })
    setResetState('busy')
    try {
      const result = await window.api.pty.management.resetFolderAccess()
      if (!mountedRef.current) {
        return
      }
      if (result.outcome !== 'probed') {
        setResetState('failed')
        return
      }
      setResetState('probed')
      // A null verdict means the evidence is gone (daemon replaced mid-reset), which unmounts this
      // dialog: there is nothing left for it to fix.
      applyVerdict(result.mismatch)
    } catch {
      if (mountedRef.current) {
        setResetState('failed')
      }
    }
  }, [applyVerdict, cwdClass, mountedRef])

  const onRestart = useCallback(async (): Promise<void> => {
    track('daemon_folder_access_notice', { action: 'restart_clicked', cwd_class: cwdClass })
    setRestartState('busy')
    try {
      const { success } = await window.api.pty.management.restart()
      if (!mountedRef.current) {
        return
      }
      setRestartState(success ? 'done' : 'failed')
      if (success) {
        // Why here: the replaced daemon's identity is gone, so the poll that raised the toast will
        // never mention it again, and a takedown the user did not ask for is not a dismissal.
        retireNotice(daemonScope)
      }
    } catch {
      if (mountedRef.current) {
        setRestartState('failed')
      }
    }
  }, [cwdClass, daemonScope, mountedRef, retireNotice])

  const folder = macFolderAccessFolderName(cwdClass)
  const busy = restartState === 'busy' || resetState === 'busy'
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) {
          close()
        }
      }}
    >
      <DialogContent
        className="max-w-md"
        showCloseButton={!busy}
        onPointerDownOutside={(event) => {
          if (busy) {
            event.preventDefault()
          }
        }}
        onEscapeKeyDown={(event) => {
          if (busy) {
            event.preventDefault()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.shared.MacFolderAccessFixDialog.title',
              'Fix access to your {{folder}}',
              { folder }
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.shared.MacFolderAccessFixDialog.lead',
              'macOS is blocking Orca’s terminal service from this folder.'
            )}
          </DialogDescription>
        </DialogHeader>
        <FixSteps
          mismatch={mismatch}
          restartState={restartState}
          resetState={resetState}
          folder={folder}
        />
        <DialogFooter>
          <FixFooter
            mismatch={mismatch}
            restartState={restartState}
            resetState={resetState}
            onCancel={close}
            onOpenSettings={onOpenSettings}
            onReset={() => void onReset()}
            onRestart={() => void onRestart()}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Shown only while the scope the user opened is still the one the evidence is about, so no remedy
 * phase can outlive its evidence and nothing here has to be closed by hand.
 */
export function MacFolderAccessFixDialog(): React.JSX.Element | null {
  const mismatch = useMacFolderAccessFixStore((s) => s.mismatch)
  const openScope = useMacFolderAccessFixStore((s) => s.openScope)
  if (!mismatch || !openScope) {
    return null
  }
  return <FolderAccessFix mismatch={mismatch} />
}
