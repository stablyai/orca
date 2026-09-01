import { AlertTriangle, Wrench } from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { SettingsSwitch } from './SettingsFormControls'
import { AgentCatalogStatusBadge, agentCatalogStatusLabel } from './AgentCatalogStatusBadge'
import { CustomAgentRowActions } from './CustomAgentRowActions'
import type { AgentCatalogRow } from './agent-catalog-rows'

export type AgentCatalogRowCallbacks = {
  onToggleEnabled: (row: AgentCatalogRow, enabled: boolean) => void
  onEdit: (row: AgentCatalogRow) => void
  onDuplicate: (row: AgentCatalogRow) => void
  onDelete: (row: AgentCatalogRow) => void
  onRepair: (row: AgentCatalogRow) => void
  onReviewReferences: (row: AgentCatalogRow) => void
}

/** An action rendered disabled with a hover reason instead of live, used while a
 *  later intra-unit landing still owns its dialog. Absent means the action is live. */
export type AgentCatalogActionDisabled = { disabledReason: string }

/** Surface a disabled action's reason through a focus-reachable Tooltip rather
 *  than the native `title` attr (STYLEGUIDE: `title` isn't reliably announced by
 *  assistive tech and isn't focusable). A disabled button emits no pointer/focus
 *  events, so the span wrapper carries them for keyboard and screen-reader users. */
function DisabledReason({
  reason,
  children
}: {
  reason: string | undefined
  children: React.ReactNode
}): React.JSX.Element {
  if (!reason) {
    return <>{children}</>
  }
  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="inline-flex outline-none">
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6} className="max-w-[280px] leading-relaxed">
          {reason}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export type AgentCatalogActionAvailability = {
  builtInEdit?: AgentCatalogActionDisabled
  delete?: AgentCatalogActionDisabled
  repair?: AgentCatalogActionDisabled
  reviewReferences?: AgentCatalogActionDisabled
}

export type AgentCatalogRowViewProps = {
  row: AgentCatalogRow
  availability?: AgentCatalogActionAvailability
} & AgentCatalogRowCallbacks

const ROW_CLASS = 'flex items-center gap-3 px-1 py-2.5'

export function AgentCatalogRowView({
  row,
  availability,
  ...callbacks
}: AgentCatalogRowViewProps): React.JSX.Element {
  switch (row.kind) {
    case 'built-in':
    case 'custom':
      return <ConfiguredRow row={row} availability={availability} {...callbacks} />
    case 'repair':
      return <RepairRow row={row} onRepair={callbacks.onRepair} disabled={availability?.repair} />
    case 'deleted':
      return (
        <DeletedRow
          row={row}
          onReviewReferences={callbacks.onReviewReferences}
          disabled={availability?.reviewReferences}
        />
      )
  }
}

function ConfiguredRow({
  row,
  availability,
  onToggleEnabled,
  onEdit,
  onDuplicate,
  onDelete
}: {
  row: Extract<AgentCatalogRow, { kind: 'built-in' | 'custom' }>
  availability?: AgentCatalogActionAvailability
} & AgentCatalogRowCallbacks): React.JSX.Element {
  return (
    <div className={ROW_CLASS}>
      <AgentIcon agent={row.baseAgent} size={16} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{row.label}</span>
          <AgentCatalogStatusBadge status={row.status} />
        </div>
        <p className="truncate text-xs text-muted-foreground">{row.commandSummary}</p>
      </div>
      <SettingsSwitch
        checked={row.enabled}
        onChange={() => onToggleEnabled(row, !row.enabled)}
        ariaLabel={translate(
          'auto.components.settings.AgentCatalogRowView.enableSwitch',
          'Enable {{agent}}',
          { agent: row.label }
        )}
      />
      <CustomAgentRowActions
        rowKind={row.kind}
        agentLabel={row.label}
        onEdit={() => onEdit(row)}
        onDuplicate={() => onDuplicate(row)}
        onDelete={row.kind === 'custom' ? () => onDelete(row) : undefined}
        editDisabledReason={
          row.kind === 'built-in' ? availability?.builtInEdit?.disabledReason : undefined
        }
        deleteDisabledReason={
          row.kind === 'custom' ? availability?.delete?.disabledReason : undefined
        }
      />
    </div>
  )
}

function RepairRow({
  row,
  onRepair,
  disabled
}: {
  row: Extract<AgentCatalogRow, { kind: 'repair' }>
  onRepair: (row: AgentCatalogRow) => void
  disabled?: AgentCatalogActionDisabled
}): React.JSX.Element {
  const label =
    row.label ??
    translate('auto.components.settings.AgentCatalogRowView.repairFallbackLabel', 'Custom agent')
  return (
    <div className={ROW_CLASS}>
      <AgentIcon agent={row.baseAgent ?? null} size={16} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-muted-foreground">{label}</span>
          <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500">
            <AlertTriangle className="size-3" />
            {agentCatalogStatusLabel('repair-required')}
          </span>
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.AgentCatalogRowView.repairHint',
            'This definition must be repaired before it can launch.'
          )}
        </p>
      </div>
      <DisabledReason reason={disabled?.disabledReason}>
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={Boolean(disabled)}
          onClick={() => onRepair(row)}
        >
          <Wrench className="size-3.5" />
          {translate('auto.components.settings.AgentCatalogRowView.repair', 'Repair')}
        </Button>
      </DisabledReason>
    </div>
  )
}

function DeletedRow({
  row,
  onReviewReferences,
  disabled
}: {
  row: Extract<AgentCatalogRow, { kind: 'deleted' }>
  onReviewReferences: (row: AgentCatalogRow) => void
  disabled?: AgentCatalogActionDisabled
}): React.JSX.Element {
  return (
    <div className={cn(ROW_CLASS, 'opacity-70')}>
      <AgentIcon agent={row.baseAgent} size={16} />
      <div className="min-w-0 flex-1">
        <span className="truncate text-sm font-medium text-muted-foreground">{row.label}</span>
        <p className="truncate text-xs text-muted-foreground">
          {row.referenceCount === null || row.referenceCount <= 0
            ? translate('auto.components.settings.AgentCatalogRowView.deleted', 'Deleted')
            : translate(
                'auto.components.settings.AgentCatalogRowView.deletedUsedBy',
                'Deleted — still used by {{items}} items',
                { items: row.referenceCount }
              )}
        </p>
      </div>
      <DisabledReason reason={disabled?.disabledReason}>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={Boolean(disabled)}
          onClick={() => onReviewReferences(row)}
        >
          {translate(
            'auto.components.settings.AgentCatalogRowView.reviewReferences',
            'Review references'
          )}
        </Button>
      </DisabledReason>
    </div>
  )
}
