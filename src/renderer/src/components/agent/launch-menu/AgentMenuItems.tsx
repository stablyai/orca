import { terminalPendingReason } from './new-tab-agent-menu-model'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import { SubscribedAgentLaunchPickerMenu } from '@/components/agent/AgentLaunchPickerMenu'
import React from 'react'
import { TabAgentSurfaceChoiceRow } from './TabAgentSurfaceChoiceRow'
import { OpenAgentSettingsMenuItem } from './OpenAgentSettingsMenuItem'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut
} from '@/components/ui/dropdown-menu'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { useOptionalShortcutLabel } from '@/lib/keyboard/useShortcutLabel'
import { useAgentMenuShortcutLabels } from './agent-menu-shortcut-labels'
import type { AgentPickerEntry } from '../../../../../shared/agent-launch/picker/agent-launch-picker'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { NewTabAgentMenuRow } from '../../../../../shared/agent-launch/picker/agent-launch-picker-rows'
import type { AgentPickerInventorySource } from '../agent-picker-inventory-source'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { cn } from '@/lib/class-names'
import { useNewTabAgentMenuRows } from './use-new-tab-agent-menu-rows'
import type { NewTabAgentMenuModel } from './new-tab-agent-menu-model'
import { useAgentDetectionTargetForWorktree } from '@/lib/agent-session/launch/inventory/useAgentDetectionTarget'
import {
  chatUnavailableLabel,
  rowStatusLabel,
  rowTitle,
  rowLabel,
  rowId
} from './agent-menu-row-presentation'
import {
  getCatalogEntry,
  useTabAgentMenuLaunch,
  type QuickLaunchAgentMenuItemsProps
} from './use-tab-agent-menu-launch'

export { useTabAgentMenuLaunch, type QuickLaunchAgentMenuItemsProps }

const PLACEHOLDER_WIDTHS = ['w-3/5', 'w-1/2', 'w-2/3', 'w-2/5', 'w-3/4', 'w-1/3', 'w-4/5', 'w-1/4']

function QuickLaunchAgentMenuItemsInner(props: QuickLaunchAgentMenuItemsProps): React.JSX.Element {
  useUiLanguageRevision()
  const detectionTarget = useAgentDetectionTargetForWorktree(props.worktreeId)
  const model = useNewTabAgentMenuRows(props.worktreeId, true, detectionTarget)
  const runLaunch = useTabAgentMenuLaunch(props)
  return <ProjectedAgentMenuItems {...props} model={model} runLaunch={runLaunch} />
}

export function ProjectedAgentMenuItems({
  disabled = false,
  model,
  runLaunch,
  pickerInventory,
  onSelectPickerAgent,
  hidePickerSearch
}: {
  disabled?: boolean
  model: NewTabAgentMenuModel
  runLaunch: React.ComponentProps<typeof SubscribedAgentLaunchPickerMenu>['runLaunch']
  pickerInventory?: AgentPickerInventorySource
  onSelectPickerAgent?: (agent: AgentPickerEntry['agent']) => void
  hidePickerSearch?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const desktopDefaultAgent = useAppStateValue((s) => s.settings?.defaultTuiAgent)
  const newAgentShortcut = useOptionalShortcutLabel('tab.newAgent')
  const shortcutLabels = useAgentMenuShortcutLabels(pickerInventory ? model : undefined)
  if (model.state === 'loading') {
    // Why: rows fill in once when every answer is known, instead of reshuffling under the pointer.
    return (
      <>
        {PLACEHOLDER_WIDTHS.slice(0, model.placeholderCount).map((width) => (
          <DropdownMenuItem
            key={width}
            variant="launch"
            disabled
            aria-label={t(
              'auto.components.tab.bar.QuickLaunchButton.agentsLoading',
              'Loading agents'
            )}
          >
            <span aria-hidden="true" className="flex h-[1lh] flex-1 items-center">
              <span className={cn('h-2 rounded-full bg-muted', width)} />
            </span>
          </DropdownMenuItem>
        ))}
        <OpenAgentSettingsMenuItem />
      </>
    )
  }
  const {
    rows,
    detection: { detectedIds, detectionFailed, needsServerUpdate }
  } = model
  const defaultAgent = 'defaultTuiAgent' in model ? model.defaultTuiAgent : desktopDefaultAgent
  return (
    <>
      {(detectedIds === null && (detectionFailed || needsServerUpdate)) || rows.length === 0 ? (
        <DropdownMenuItem variant="launch" disabled>
          <span className="font-normal text-muted-foreground">
            {needsServerUpdate
              ? t(
                  'auto.components.tab.bar.QuickLaunchButton.terminalListNeedsServerUpdate',
                  'Update Orca on this server to list terminal agents'
                )
              : detectionFailed
                ? t(
                    'auto.components.tab.bar.QuickLaunchButton.terminalListFailed',
                    'Couldn’t list terminal agents for this workspace'
                  )
                : detectedIds && detectedIds.length > 0
                  ? t('auto.components.tab.bar.QuickLaunchButton.8dea9b5cdf', 'No enabled agents')
                  : t('auto.components.tab.bar.QuickLaunchButton.e518f544b1', 'No agents detected')}
          </span>
        </DropdownMenuItem>
      ) : null}
      {pickerInventory ? (
        <SubscribedAgentLaunchPickerMenu
          shortcutLabels={shortcutLabels}
          model={model}
          inventory={pickerInventory}
          runLaunch={runLaunch}
          onSelectAgent={onSelectPickerAgent}
          hideSearch={hidePickerSearch}
        />
      ) : (
        rows.map((row, index) => {
          const { agent } = row
          const label = getCatalogEntry(agent)?.label ?? agent
          // Chat rows come first; the rows that open a terminal start their own group.
          const startsCliGroup = row.kind === 'cli' && index > 0 && rows[index - 1]?.kind !== 'cli'
          if (row.kind === 'chat-unavailable') {
            return (
              <DropdownMenuItem key={rowId(row)} variant="launch" disabled>
                <AgentIcon agent={agent} size={14} />
                <span className="flex-1">{label}</span>
                <span className="font-normal text-muted-foreground">
                  {chatUnavailableLabel(row.reason, t)}
                </span>
              </DropdownMenuItem>
            )
          }
          const showsDefaultAgentShortcut =
            newAgentShortcut !== null && defaultAgent !== 'blank' && agent === defaultAgent
          const pendingReason = terminalPendingReason(model.terminalPending, row, t)
          const rowContent = (
            <>
              <AgentIcon agent={agent} size={14} />
              <span className="min-w-0 flex-1 truncate">{rowLabel(row, t)}</span>
              {pendingReason ? (
                <span className="min-w-0 shrink truncate text-xs text-muted-foreground">
                  {pendingReason}
                </span>
              ) : rowStatusLabel(row, t) ? (
                <span className="text-xs text-muted-foreground">{rowStatusLabel(row, t)}</span>
              ) : null}
              {showsDefaultAgentShortcut ? (
                <DropdownMenuShortcut>{newAgentShortcut}</DropdownMenuShortcut>
              ) : null}
            </>
          )
          const other = otherSurfaceRow(row, detectedIds)
          return (
            <React.Fragment key={rowId(row)}>
              {startsCliGroup ? <DropdownMenuSeparator /> : null}
              {other ? (
                <TabAgentSurfaceChoiceRow
                  row={row}
                  other={other}
                  label={label}
                  terminalPending={model.terminalPending}
                  disabled={disabled}
                  runLaunch={runLaunch}
                >
                  {rowContent}
                </TabAgentSurfaceChoiceRow>
              ) : (
                <DropdownMenuItem
                  variant="launch"
                  disabled={disabled || !!pendingReason}
                  aria-description={pendingReason}
                  onSelect={(event) => {
                    if (runLaunch(row) === false) {
                      event.preventDefault()
                    }
                  }}
                  title={rowTitle(row, label, t)}
                >
                  {rowContent}
                </DropdownMenuItem>
              )}
            </React.Fragment>
          )
        })
      )}
      <OpenAgentSettingsMenuItem />
    </>
  )
}

/** The same agent on the other surface: a chat's detected CLI, or a CLI-set agent's chat. */
function otherSurfaceRow(
  row: Exclude<NewTabAgentMenuRow, { kind: 'chat-unavailable' }>,
  detectedIds: readonly TuiAgent[] | null
): NewTabAgentMenuRow | null {
  const { agent, executionHostId } = row
  if (row.kind === 'chat') {
    return detectedIds?.includes(agent) ? { kind: 'cli', agent, executionHostId } : null
  }
  return row.kind === 'cli' && row.chat ? { kind: 'chat', agent, executionHostId } : null
}

export const QuickLaunchAgentMenuItems = React.memo(QuickLaunchAgentMenuItemsInner)
