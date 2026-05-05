import React from 'react'
import { ExternalLink, Play } from 'lucide-react'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
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
        'group grid items-center gap-3 border-b border-border/30 px-3 py-2 hover:bg-muted/30',
        disabled && 'opacity-60'
      )}
      style={{ gridTemplateColumns: buildGridTemplate(fields) }}
    >
      {fields.map((f) => (
        <ProjectCell
          key={f.id}
          row={row}
          field={f}
          editable={editable}
          onEditField={onEditField}
          onEditAssignees={onEditAssignees}
          onEditLabels={onEditLabels}
          onEditIssueType={onEditIssueType}
          onOpenDialog={f.dataType === 'TITLE' ? onOpenDialog : undefined}
        />
      ))}
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

export function buildGridTemplate(fields: GitHubProjectField[]): string {
  // Why: TITLE gets the most space; other columns share equally. The extra
  // trailing column is for row-hover action icons.
  const cols: string[] = fields.map((f) =>
    f.dataType === 'TITLE' ? 'minmax(0,3fr)' : 'minmax(80px,1fr)'
  )
  cols.push('80px')
  return cols.join(' ')
}
