import React from 'react'
import { AlertCircle, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { isTerminalBackgroundLight } from '../../../../../shared/terminal-title-contrast'
import type {
  AzureDevOpsBoardCardField,
  AzureDevOpsBoardConfiguration,
  AzureDevOpsWorkItem,
  AzureDevOpsWorkItemTypeMetadata
} from '../../../../../shared/azure-devops/boards-types'
import { resolveAzureDevOpsCardStyle } from '@/components/task-page-azure-devops-card-style'
import {
  PARENT_FIELD,
  STATE_FIELD,
  TAGS_FIELD,
  TITLE_FIELD
} from '@/components/task-page-azure-devops-backlog-columns'
import { formatBacklogCell } from './BacklogCells'
import { WorkItemStateDot, WorkItemTagChip, WorkItemTypeIcon } from './WorkItemVisuals'

export type AzureDevOpsBoardCardProps = {
  item: AzureDevOpsWorkItem
  configuration: AzureDevOpsBoardConfiguration
  typeMetadata: AzureDevOpsWorkItemTypeMetadata | null
  parent: AzureDevOpsWorkItem | null
  /** The parent's own type metadata, so its row carries the parent type's icon. */
  parentTypeMetadata?: AzureDevOpsWorkItemTypeMetadata | null
  /** The card's column value matched no column, so it sits in the first in-progress one. */
  unplaced?: boolean
  onOpen: () => void
  onUse: () => void
}

const ID_FIELD = 'System.Id'
const ASSIGNED_TO_FIELD = 'System.AssignedTo'
const EFFORT_FIELD = 'Microsoft.VSTS.Scheduling.Effort'
/** The card header always paints these, so the field list must not repeat them. */
const HEADER_FIELDS = new Set([TITLE_FIELD, ID_FIELD])

/** ADO serves no display names with the board settings; derive a label from the reference name. */
function cardFieldLabel(referenceName: string): string {
  const leaf = referenceName.split('.').at(-1) ?? referenceName
  return leaf.replaceAll(/([a-z\d])([A-Z])/g, '$1 $2')
}

function isEmptyValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  )
}

function LabelledValue({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <>
      <span className="shrink-0 opacity-70">{label}</span>
      <span className="min-w-0 truncate" title={value}>
        {value}
      </span>
    </>
  )
}

function CardFieldBody({
  field,
  card
}: {
  field: AzureDevOpsBoardCardField
  card: AzureDevOpsBoardCardProps
}): React.JSX.Element {
  const { item, configuration, typeMetadata, parent } = card
  const name = field.referenceName
  const label = cardFieldLabel(name)
  if (name === TAGS_FIELD) {
    return (
      <span className="flex min-w-0 flex-wrap gap-1">
        {item.tags.map((tag) => (
          <WorkItemTagChip key={tag} tag={tag} color={configuration.tagColors[tag] ?? null} />
        ))}
      </span>
    )
  }
  if (name === STATE_FIELD) {
    return <WorkItemStateDot state={item.state} metadata={typeMetadata ?? undefined} />
  }
  if (name === PARENT_FIELD && parent) {
    return (
      <>
        <span
          data-card-parent-type={parent.workItemType}
          className="inline-flex shrink-0"
          style={{ color: card.parentTypeMetadata?.color ?? undefined }}
        >
          <WorkItemTypeIcon metadata={card.parentTypeMetadata ?? undefined} className="size-3.5" />
        </span>
        <span className="min-w-0 truncate" title={parent.title}>
          {parent.title}
        </span>
      </>
    )
  }
  if (name === PARENT_FIELD) {
    return <LabelledValue label={label} value={item.parentId === null ? '' : `#${item.parentId}`} />
  }
  if (name === ASSIGNED_TO_FIELD) {
    return (
      <>
        {item.assignedTo?.imageUrl ? (
          <img
            src={item.assignedTo.imageUrl}
            alt=""
            width={16}
            height={16}
            className="size-4 shrink-0 rounded-full"
          />
        ) : null}
        <span className="min-w-0 truncate">{formatBacklogCell(name, item.fields[name])}</span>
      </>
    )
  }
  if (name === EFFORT_FIELD) {
    return (
      <>
        <span className="shrink-0 opacity-70">{label}</span>
        <span className="ml-auto shrink-0 rounded-sm bg-muted/60 px-1 font-medium tabular-nums">
          {formatBacklogCell(name, item.fields[name])}
        </span>
      </>
    )
  }
  return <LabelledValue label={label} value={formatBacklogCell(name, item.fields[name])} />
}

function CardFieldRow({
  field,
  card,
  showEmptyFields
}: {
  field: AzureDevOpsBoardCardField
  card: AzureDevOpsBoardCardProps
  showEmptyFields: boolean
}): React.JSX.Element | null {
  const name = field.referenceName
  if (HEADER_FIELDS.has(name)) {
    return null
  }
  const empty =
    name === TAGS_FIELD ? card.item.tags.length === 0 : isEmptyValue(card.item.fields[name])
  if (empty && !showEmptyFields) {
    return null
  }
  return (
    <div data-card-field={name} className="flex min-w-0 items-center gap-1.5 text-xs">
      <CardFieldBody field={field} card={card} />
    </div>
  )
}

export function AzureDevOpsBoardCard(props: AzureDevOpsBoardCardProps): React.JSX.Element {
  const { item, configuration, typeMetadata } = props
  const unplacedLabel = translate(
    'auto.components.TaskPage.azureDevOps.board.unmappedCard',
    'This card is not mapped to a column on this board.'
  )
  const cardStyle = resolveAzureDevOpsCardStyle(item, configuration.styleRules)
  const settings = configuration.cardFields[item.workItemType]
  const fill = cardStyle?.backgroundColor ?? null
  // The fill is Azure's own colour, so the readable text colour comes from its luminance, not the theme.
  const fillIsLight = fill === null ? null : isTerminalBackgroundLight(fill)
  return (
    <div
      data-board-card={item.id}
      role="button"
      tabIndex={0}
      onClick={props.onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) {
          return
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          props.onOpen()
        }
      }}
      className={cn(
        'group/card flex cursor-pointer flex-col gap-1 rounded-sm border border-border/60 border-l-2 bg-background px-2 py-1.5 text-left shadow-sm transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        fill === null && 'hover:bg-accent',
        fillIsLight === true && 'text-black',
        fillIsLight === false && 'text-white'
      )}
      style={{
        borderLeftColor: typeMetadata?.color ?? undefined,
        backgroundColor: fill ?? undefined
      }}
    >
      <div data-board-card-header className="flex min-w-0 items-center gap-1.5">
        <span
          data-board-card-type={item.workItemType}
          className="inline-flex shrink-0"
          style={{ color: typeMetadata?.color ?? undefined }}
        >
          <WorkItemTypeIcon metadata={typeMetadata ?? undefined} className="size-3.5" />
        </span>
        <span
          data-board-card-id
          className={cn(
            'font-mono text-2xs',
            fill === null ? 'text-muted-foreground' : 'opacity-70'
          )}
        >
          {item.id}
        </span>
        {props.unplaced === true ? (
          <span
            data-board-card-unplaced
            role="img"
            aria-label={unplacedLabel}
            title={unplacedLabel}
            className="inline-flex shrink-0 text-status-warning"
          >
            <AlertCircle className="size-3.5" />
          </span>
        ) : null}
        {/* Why: the reveal lives on a wrapper because the Button primitive owns its own effects. */}
        <span className="ml-auto shrink-0 opacity-0 focus-within:opacity-100 group-hover/card:opacity-100">
          <Button
            variant="ghost"
            size="xs"
            onClick={(event) => {
              event.stopPropagation()
              props.onUse()
            }}
          >
            <Play className="size-3" />
            {translate('auto.components.TaskPage.azureDevOps.useItem', 'Use')}
          </Button>
        </span>
      </div>
      <div
        data-board-card-title
        className="line-clamp-3 text-[13px] font-medium leading-snug"
        style={{ color: cardStyle?.titleColor ?? undefined }}
      >
        {item.title}
      </div>
      {(settings?.fields ?? []).map((field) => (
        <CardFieldRow
          key={field.referenceName}
          field={field}
          card={props}
          showEmptyFields={settings?.showEmptyFields ?? false}
        />
      ))}
    </div>
  )
}
