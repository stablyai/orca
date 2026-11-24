import { Trans } from 'react-i18next'
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import { i18n } from '@/i18n/i18n'

export function DeleteWorktreeDialogDescription({
  description,
  targetClassName,
  targetName
}: {
  /** Translated sentence from delete-worktree-dialog-copy with <target> / <descendants> tags. */
  description: string
  targetClassName: string
  targetName: string | undefined
}): React.JSX.Element {
  return (
    <DialogDescription>
      <Trans
        i18n={i18n}
        defaults={description}
        components={{
          target: <span className={targetClassName}>{targetName}</span>,
          descendants: <span className="font-medium text-foreground" />
        }}
      />
    </DialogDescription>
  )
}

/** Question title, an "On devbox-2" line for remote workspaces, then the one consequence line. */
export function DeleteWorktreeDialogHeading({
  title,
  worktree,
  hostLabelById,
  mainWorktreeBlocker,
  ...description
}: {
  title: string
  worktree: Worktree | null
  hostLabelById: ReadonlyMap<ExecutionHostId, string>
  /** The main worktree can't be deleted; this replaces the consequence line. */
  mainWorktreeBlocker: string | null
  description: string
  targetClassName: string
  targetName: string | undefined
}): React.JSX.Element {
  const t = useTranslate()
  const host = parseExecutionHostId(worktree?.hostId)
  const remoteHostLabel = host && host.kind !== 'local' ? hostLabelById.get(host.id) : undefined
  return (
    <DialogHeader>
      <DialogTitle className="break-all">{title}</DialogTitle>
      {remoteHostLabel ? (
        <DialogDescription size="compact">
          {t('worktree.delete.onHost', 'On {{host}}', { host: remoteHostLabel })}
        </DialogDescription>
      ) : null}
      {mainWorktreeBlocker ? (
        <p className="text-[13px] text-muted-foreground">{mainWorktreeBlocker}</p>
      ) : (
        <DeleteWorktreeDialogDescription {...description} />
      )}
    </DialogHeader>
  )
}
