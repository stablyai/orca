// Small pieces of the "Move to this computer" view.
import React from 'react'
import { FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'

/** Partial result: what didn't apply was saved; open it, or apply it again on the same worktree. */
export function CloudMovePartialResult({
  folder,
  conflicts,
  notWritten,
  onOpenFolder,
  onReapply
}: {
  folder: string
  conflicts: string[]
  /** Untracked files not written because something else is at that path here. */
  notWritten: string[]
  onOpenFolder: (dir: string) => void
  onReapply?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <p className="text-sm">
        {t(
          'orcaCloudMove.partialDetail',
          'Some changes didn’t apply cleanly. They were saved here, so nothing is lost:'
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="xs"
          variant="outline"
          className="max-w-full justify-start"
          onClick={() => onOpenFolder(folder)}
        >
          <FolderOpen />
          {t('orcaCloudMove.openFolder', 'Open folder')}
        </Button>
        {onReapply ? (
          <Button size="xs" variant="ghost" onClick={onReapply}>
            {t('orcaCloudMove.reapplyShort', 'Reapply')}
          </Button>
        ) : null}
      </div>
      {notWritten.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t('orcaCloudMove.notWritten', 'Already here, not overwritten: {{files}}', {
            files: notWritten.slice(0, 5).join(', ')
          })}
        </p>
      ) : null}
      {conflicts.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t('orcaCloudMove.conflicts', 'Changed here since: {{files}}', {
            files: conflicts.slice(0, 5).join(', ')
          })}
        </p>
      ) : null}
      <p className="break-all font-mono text-xs text-muted-foreground" title={folder}>
        {folder}
      </p>
    </div>
  )
}
