// Small pieces of the "Move to this computer" view.
import React, { useEffect } from 'react'
import { FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { CloudMoveState } from '@/lib/orca-cloud/orca-cloud-move-store'

/** Neutral bullets for what will move (not checkmarks: nothing has happened yet). */
export function BulletList({
  items
}: {
  items: { key: string; node: React.ReactNode }[]
}): React.JSX.Element {
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-sm marker:text-muted-foreground">
      {items.map((item) => (
        <li key={item.key}>{item.node}</li>
      ))}
    </ul>
  )
}

/** Moves focus to the stage's main control whenever the stage changes. */
export function useFocusOnStage(
  stage: Exclude<CloudMoveState, { stage: 'closed' }>['stage'],
  ref: React.RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    ref.current?.focus()
  }, [stage, ref])
}

/** Partial result: what didn't apply was saved; open it, or apply it again on the same worktree. */
export function CloudMovePartialResult({
  folder,
  conflicts,
  primary,
  onOpenFolder,
  onReapply
}: {
  folder: string
  conflicts: string[]
  primary: React.RefObject<HTMLButtonElement | null>
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
          ref={primary}
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
            {t('orcaCloudMove.reapply', 'Apply changes again')}
          </Button>
        ) : null}
      </div>
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
