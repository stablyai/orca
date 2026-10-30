import React from 'react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import type { WslMoveResult } from '../../../../shared/wsl-move/wsl-move-driver-types'
import type { LazyChunkRecoveryReloadOutcome } from '@/lib/lazy-chunk-recovery-reload'
import { wslMoveBrowserLoginsNotCopied, wslMoveRefusalMessage } from './wsl-move-copy'
import { WslMoveBlockerList, type WslMoveBlockerView } from './WslMoveBlockerList'

export type WslMoveReloadState = 'idle' | 'reloading' | LazyChunkRecoveryReloadOutcome

export function wslMoveResultTitle(result: WslMoveResult, distro: string): string {
  switch (result.outcome) {
    case 'moved':
      return translate('wslMove.result.movedTitle', 'Moved to the {{distro}} host', { distro })
    case 'reset':
      return translate('wslMove.result.resetTitle', 'Nothing was moved')
    case 'waiting-for-host':
      return translate('wslMove.result.waitingTitle', 'Waiting for the {{distro}} host', {
        distro
      })
    case 'refused':
      return result.code === 'wsl_move_finished_earlier_move'
        ? translate('wslMove.result.earlierMoveTitle', 'An earlier move finished first')
        : translate('wslMove.result.refusedTitle', 'Projects not moved')
  }
}

function reloadFailure(reload: WslMoveReloadState): string | null {
  switch (reload) {
    case 'idle':
    case 'reloading':
      return null
    case 'checkpoint-refused':
      return translate(
        'wslMove.result.reloadCheckpointRefused',
        'Orca could not back up unsaved files, so the window did not reload. Close this dialog, save or close those files, then use Reload now in the notice that stays open.'
      )
    case 'unload-vetoed':
      return translate(
        'wslMove.result.reloadVetoed',
        'Something kept the window from reloading. Close this dialog, save your work, then use Reload now in the notice that stays open.'
      )
    case 'never-landed':
    case 'request-failed':
      return translate('wslMove.result.reloadFailed', 'The window did not reload. Try again.')
  }
}

export function WslMoveResultBody({
  distro,
  result,
  blockers,
  reload,
  onReload,
  onReview,
  onClose
}: {
  distro: string
  result: WslMoveResult
  blockers: WslMoveBlockerView[]
  reload: WslMoveReloadState
  onReload: () => void
  onReview: () => void
  onClose: () => void
}): React.JSX.Element {
  const needsReload =
    result.outcome === 'moved' ||
    (result.outcome === 'refused' && result.code === 'wsl_move_finished_earlier_move')
  const failure = reloadFailure(reload)
  return (
    <>
      <div
        className="space-y-3 text-sm"
        data-testid="wsl-move-result"
        data-outcome={result.outcome}
      >
        {result.outcome === 'moved' ? (
          <>
            <p>
              {translate(
                'wslMove.result.moved',
                'Reload this window to see the projects under the {{distro}} host. Orca backs up unsaved files before it reloads.',
                { distro }
              )}
            </p>
            {result.automationsPending?.length ? (
              <p data-testid="wsl-move-automations-pending">
                {result.automationsPending.length === 1
                  ? translate(
                      'wslMove.result.automationsPendingOne',
                      'One automation is off on the host for now. Orca keeps asking the host to turn it back on.'
                    )
                  : translate(
                      'wslMove.result.automationsPendingMany',
                      '{{n}} automations are off on the host for now. Orca keeps asking the host to turn them back on.',
                      { n: result.automationsPending.length }
                    )}
              </p>
            ) : null}
            {result.browserLoginsNotCopiedReason ? (
              <p>{wslMoveBrowserLoginsNotCopied(result.browserLoginsNotCopiedReason)}</p>
            ) : null}
            <p className="text-muted-foreground">
              {translate(
                'wslMove.result.undoHint',
                'Changed your mind? After the reload, the sidebar lists these projects as “Moved to {{distro}} host”. Choose “Use on this computer again” there to bring them back as they were before the move.',
                { distro }
              )}
            </p>
          </>
        ) : null}
        {result.outcome === 'reset' ? (
          <>
            <p>
              {translate(
                'wslMove.result.reset',
                'The move stopped and everything was put back. The projects work on this computer as before; paused terminals start again when you open them.'
              )}
            </p>
            {result.detail ? (
              <p className="text-xs text-muted-foreground" data-testid="wsl-move-reset-reason">
                {translate('wslMove.result.resetReason', 'Why it stopped: {{detail}}', {
                  detail: result.detail
                })}
              </p>
            ) : null}
          </>
        ) : null}
        {result.outcome === 'waiting-for-host' ? (
          <p>
            {translate(
              'wslMove.result.waiting',
              'The move may have reached the {{distro}} host, but the host is not answering. These projects stay read-only here until it does. Connect the host in Settings, then open this dialog again and start a move: Orca finishes or undoes this one first.',
              { distro }
            )}
          </p>
        ) : null}
        {result.outcome === 'refused' ? (
          <div className="space-y-1">
            <p>{wslMoveRefusalMessage(result, distro)}</p>
            {result.reasons?.length ? (
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                {result.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {blockers.length > 0 ? <WslMoveBlockerList blockers={blockers} /> : null}
        {failure ? (
          <p className="text-destructive" role="alert">
            {failure}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        {needsReload ? (
          <Button type="button" disabled={reload === 'reloading'} onClick={onReload}>
            {reload === 'reloading'
              ? translate('wslMove.result.reloading', 'Reloading…')
              : translate('wslMove.result.reload', 'Reload now')}
          </Button>
        ) : (
          <>
            <Button type="button" variant="ghost" onClick={onClose}>
              {translate('wslMove.result.close', 'Close')}
            </Button>
            {result.outcome === 'refused' || result.outcome === 'reset' ? (
              <Button type="button" variant="outline" onClick={onReview}>
                {translate('wslMove.result.review', 'Back to projects')}
              </Button>
            ) : null}
          </>
        )}
      </DialogFooter>
    </>
  )
}
