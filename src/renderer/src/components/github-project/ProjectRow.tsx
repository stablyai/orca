import React from 'react'
import { ExternalLink, Play } from 'lucide-react'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import ColumnResizeHandle from './ColumnResizeHandle'
import { resolveWidth } from './column-widths'
import ProjectCell from './ProjectCell'
import type {
  GitHubIssueType,
  GitHubProjectField,
  GitHubProjectFieldMutationValue,
  GitHubProjectRow as GitHubProjectRowType
} from '../../../../shared/github-project-types'

type Props = {
  row: GitHubProjectRowType
  fields: GitHubProjectField[]
  gridTemplate: string
  widths: Readonly<Record<string, number>>
  onResizeColumn: (fieldId: string, width: number, nextFieldId: string, nextWidth: number) => void
  editable: boolean
  onOpenDialog?: () => void
  onEditField?: (fieldId: string, value: GitHubProjectFieldMutationValue | null) => void
  onEditAssignees?: (add: string[], remove: string[]) => void
  onEditLabels?: (add: string[], remove: string[]) => void
  onEditIssueType?: (issueType: GitHubIssueType | null) => void
  onStartWork?: () => void
  onOpenInBrowser?: () => void
}

export default function ProjectRow({
  row,
  fields,
  gridTemplate,
  widths,
  onResizeColumn,
  editable,
  onOpenDialog,
  onEditField,
  onEditAssignees,
  onEditLabels,
  onEditIssueType,
  onStartWork,
  onOpenInBrowser
}: Props): React.JSX.Element {
  const disabled = row.itemType === 'REDACTED'
  // Why: design doc §Row actions — draft-issue rows have no URL or number, so
  // the title is non-interactive. Surface the draft body in a hover card so
  // the user can still read context without round-tripping to GitHub.
  const draftBody =
    row.itemType === 'DRAFT_ISSUE' && row.content.body && row.content.body.trim().length > 0
      ? row.content.body
      : null
  const rowInner = (
    <div
      className={cn(
        'group grid min-h-10 items-stretch gap-3 border-b border-border/30 px-3 hover:bg-accent/60',
        disabled && 'opacity-60'
      )}
      style={{ gridTemplateColumns: gridTemplate }}
    >
      {fields.map((f, idx) => {
        const next = fields[idx + 1]
        return (
          <div key={f.id} className="relative flex min-w-0 items-stretch overflow-hidden">
            <div className="flex min-w-0 flex-1 items-stretch overflow-hidden">
              <ProjectCell
                row={row}
                field={f}
                editable={editable}
                onEditField={onEditField}
                onEditAssignees={onEditAssignees}
                onEditLabels={onEditLabels}
                onEditIssueType={onEditIssueType}
                onOpenDialog={f.dataType === 'TITLE' ? onOpenDialog : undefined}
              />
            </div>
            {next ? (
              <ColumnResizeHandle
                fieldId={f.id}
                nextFieldId={next.id}
                currentWidth={resolveWidth(f, widths)}
                nextWidth={resolveWidth(next, widths)}
                onResize={onResizeColumn}
              />
            ) : null}
          </div>
        )
      })}
      <div className="flex items-center justify-end gap-1 opacity-0 transition group-hover:opacity-100">
        {row.content.url ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onOpenInBrowser}
                aria-label="Open in GitHub"
                className="rounded p-1 hover:bg-muted"
              >
                <ExternalLink className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Open in GitHub</TooltipContent>
          </Tooltip>
        ) : null}
        {!disabled && row.itemType !== 'DRAFT_ISSUE' && row.content.number != null ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onStartWork}
                aria-label="Start work"
                className="rounded p-1 hover:bg-muted"
              >
                <Play className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Start work</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </div>
  )

  if (draftBody) {
    return (
      <HoverCard openDelay={150}>
        <HoverCardTrigger asChild>{rowInner}</HoverCardTrigger>
        <HoverCardContent
          align="start"
          sideOffset={4}
          className="max-h-80 w-96 overflow-y-auto whitespace-pre-wrap text-xs"
        >
          {draftBody}
        </HoverCardContent>
      </HoverCard>
    )
  }
  return rowInner
}
