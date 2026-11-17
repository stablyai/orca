import React, { useMemo } from 'react'
import { useAppStore } from '@/store/index'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { WorkspaceLabel } from '../../../../../shared/workspace/labels/workspace-labels'

const MAX_VISIBLE_LABELS = 3
const CAPSULE_CLASS =
  'inline-flex h-4 items-center rounded-full border px-1.5 text-[10px] leading-none font-medium text-foreground/90'

function LabelCapsule({ label }: { label: WorkspaceLabel }): React.JSX.Element {
  return (
    <span
      className={`${CAPSULE_CLASS} min-w-0 max-w-[8rem]`}
      style={{
        backgroundColor: `color-mix(in srgb, ${label.color} 18%, transparent)`,
        borderColor: `color-mix(in srgb, ${label.color} 55%, transparent)`
      }}
    >
      <span className="min-w-0 truncate">{label.name}</span>
    </span>
  )
}

/** Unknown ids (labels this desktop doesn't have) are skipped, never removed. */
export function WorktreeCardLabels({
  labelIds
}: {
  labelIds: readonly string[]
}): React.JSX.Element | null {
  const t = useTranslate()
  const workspaceLabels = useAppStore((s) => s.workspaceLabels)
  const labels = useMemo(() => {
    const byId = new Map(workspaceLabels.map((label) => [label.id, label]))
    return labelIds.flatMap((id) => byId.get(id) ?? [])
  }, [labelIds, workspaceLabels])
  if (labels.length === 0) {
    return null
  }
  const hidden = labels.slice(MAX_VISIBLE_LABELS)
  const hiddenNames = hidden.map((label) => label.name).join(', ')
  return (
    <div className="flex min-w-0 items-center gap-1 overflow-hidden" data-worktree-card-labels="">
      {labels.slice(0, MAX_VISIBLE_LABELS).map((label) => (
        <LabelCapsule key={label.id} label={label} />
      ))}
      {hidden.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={`${CAPSULE_CLASS} shrink-0 border-border bg-muted`}
              aria-label={t('workspaceLabels.card.moreLabels', 'More labels: {{names}}', {
                names: hiddenNames
              })}
            >
              +{hidden.length}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{hiddenNames}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  )
}
