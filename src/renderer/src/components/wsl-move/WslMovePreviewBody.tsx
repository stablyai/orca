import React from 'react'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DialogFooter } from '@/components/ui/dialog'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import type {
  WslMovePreview,
  WslMoveRowRef
} from '../../../../shared/wsl-move/wsl-move-driver-types'
import {
  wslMoveBrowserLoginsNotCarried,
  wslMoveChatsStayCopy,
  wslMoveRefusalMessage,
  wslMoveScopeRefusalReason
} from './wsl-move-copy'
import type { WslMoveCounts, WslMoveProjectRow } from './wsl-move-scope-rows'
import { WslMoveBlockerList, type WslMoveBlockerView } from './WslMoveBlockerList'

export type WslMovePreviewBodyProps = {
  distro: string
  rows: WslMoveProjectRow[]
  selected: readonly WslMoveRowRef[]
  counts: WslMoveCounts
  /** The selection's preview; null while it is being checked. */
  preview: WslMovePreview | null
  /** Listed by the whole-distro preview but not moved, each with why. */
  notMoving: { name: string; why: string }[]
  blockers: WslMoveBlockerView[]
  onToggle: (ref: WslMoveRowRef, checked: boolean) => void
  onSkip: (refs: WslMoveRowRef[]) => void
  onRecheck: () => void
  onStart: () => void
  onClose: () => void
}

const isSelected = (selected: readonly WslMoveRowRef[], row: WslMoveRowRef): boolean =>
  selected.some((ref) => ref.kind === row.kind && ref.id === row.id)

function countsLine(counts: WslMoveCounts, t: Translate = translate): string {
  return t(
    'wslMove.preview.counts',
    'Projects: {{projects}} · Workspaces: {{workspaces}} · Terminals: {{terminals}} · Chats: {{chats}}',
    { ...counts }
  )
}

export function WslMovePreviewBody(props: WslMovePreviewBodyProps): React.JSX.Element {
  const t = useTranslate()
  const { distro, rows, selected, preview, blockers } = props
  const ready = selected.length > 0 && wslMovePreviewStartable(preview, blockers.length)
  return (
    <>
      <div className="space-y-3 text-sm">
        <p data-testid="wsl-move-why">
          {t(
            'wslMove.preview.why',
            'Work then runs inside Linux, next to your files, so terminals, Git and file changes are faster and more reliable. Your projects don’t change, and you can move any project back with “Use on this computer again”.'
          )}
        </p>
        <p className="text-muted-foreground">
          {t(
            'wslMove.preview.whatHappens',
            'Your files stay where they are. Terminals restart in the same folder; their output, shell history and agent conversations are kept.'
          )}
        </p>
        <p data-testid="wsl-move-chats-stay">{wslMoveChatsStayCopy(t)}</p>
        {preview?.outcome === 'ready' && preview.browserLoginsNotCarried ? (
          <p data-testid="wsl-move-browser-logins">
            {wslMoveBrowserLoginsNotCarried(preview.browserLoginsNotCarried, t)}
          </p>
        ) : null}
        {rows.length > 0 ? (
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground">
              {t('wslMove.preview.projects', 'Projects in {{distro}}', { distro })}
            </div>
            <ul className="max-h-48 divide-y divide-border overflow-y-auto rounded-md border border-border scrollbar-sleek">
              {rows.map((row) => {
                const id = `wsl-move-row-${row.kind}-${row.id}`
                return (
                  <li key={id} className="flex items-center gap-2.5 px-3 py-2">
                    <Checkbox
                      id={id}
                      checked={isSelected(selected, row)}
                      onCheckedChange={(checked) => props.onToggle(row, checked === true)}
                    />
                    <label htmlFor={id} className="min-w-0 flex-1 truncate">
                      {row.name}
                    </label>
                    {row.kind === 'folder' ? (
                      <Badge variant="outline">{t('wslMove.preview.folderBadge', 'Folder')}</Badge>
                    ) : null}
                  </li>
                )
              })}
            </ul>
            {selected.length > 0 ? (
              <div className="text-xs text-muted-foreground" data-testid="wsl-move-counts">
                {countsLine(props.counts, t)}
              </div>
            ) : null}
          </div>
        ) : null}
        {props.notMoving.length > 0 ? (
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">
              {t('wslMove.preview.notMoving', 'Not moving')}
            </div>
            <ul className="space-y-0.5 text-xs">
              {props.notMoving.map((entry) => (
                <li key={entry.name} className="text-muted-foreground">
                  <span className="text-foreground">{entry.name}</span>
                  {' — '}
                  {entry.why}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {preview === null && selected.length > 0 ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoadingSpinner className="size-3.5" />
            {t('wslMove.preview.checking', 'Checking the selected projects…')}
          </div>
        ) : null}
        {preview?.outcome === 'refused' ? (
          <div className="space-y-1 text-destructive" role="alert">
            <p>{wslMoveRefusalMessage(preview, distro, 'preview', t)}</p>
            {preview.reasons?.length ? (
              <ul className="list-disc space-y-0.5 pl-5 text-xs">
                {preview.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {blockers.length > 0 ? (
          <WslMoveBlockerList blockers={blockers} onSkip={props.onSkip} />
        ) : null}
      </div>
      <DialogFooter>
        {blockers.length > 0 || preview?.outcome === 'refused' ? (
          <Button
            type="button"
            variant="outline"
            className="sm:mr-auto"
            disabled={preview === null}
            onClick={props.onRecheck}
          >
            {t('wslMove.preview.checkAgain', 'Check again')}
          </Button>
        ) : null}
        <Button type="button" variant="ghost" onClick={props.onClose}>
          {t('wslMove.cancel', 'Cancel')}
        </Button>
        <Button type="button" disabled={!ready} onClick={props.onStart}>
          {selected.length === 1
            ? t('wslMove.preview.moveOne', 'Move 1 project')
            : t('wslMove.preview.moveMany', 'Move {{n}} projects', {
                n: selected.length
              })}
        </Button>
      </DialogFooter>
    </>
  )
}

/** A start settles an earlier unfinished move first, so that refusal does not block one. */
export function wslMovePreviewStartable(preview: WslMovePreview | null, blockers: number): boolean {
  return preview?.outcome === 'ready'
    ? blockers === 0
    : preview?.code === 'wsl_move_already_in_flight'
}

/** Plain-words lines for what the whole-distro preview lists but will not move. */
export function wslMoveNotMovingLines(
  preview: WslMovePreview,
  nameOf: (ref: WslMoveRowRef) => string,
  distro: string,
  t: Translate = translate
): { name: string; why: string }[] {
  if (preview.outcome !== 'ready') {
    return []
  }
  return [
    ...preview.heldByHost.map((ref) => ({
      name: nameOf(ref),
      why: t('wslMove.preview.heldByHost', 'Already on the {{distro}} host.', { distro })
    })),
    ...preview.changed.map((ref) => ({
      name: nameOf(ref),
      why: t(
        'wslMove.preview.changed',
        'Moved earlier, then changed here by an older version of Orca. It is not moved again.'
      )
    })),
    ...preview.refused.map((entry) => ({
      name: nameOf({ kind: entry.kind === 'repo' ? 'repo' : 'folder', id: entry.id }),
      why: wslMoveScopeRefusalReason(entry.reason, t)
    }))
  ]
}
