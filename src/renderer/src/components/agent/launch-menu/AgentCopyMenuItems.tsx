import { useAppStateValue } from '@/store/retained-views/app-state-view'
import { useTranslate } from '@/i18n/use-translate'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import type { SubscribedAgentLaunchPickerMenu } from '@/components/agent/AgentLaunchPickerMenu'
import {
  normalizeAgentCopies,
  type AgentCopy
} from '../../../../../shared/agent-launch/catalog/agent-copies'
import { isTuiAgentEnabled } from '../../../../../shared/agent-launch/catalog/tui-agent-selection'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { NewTabAgentMenuRow } from '../../../../../shared/agent-launch/picker/agent-launch-picker-rows'
import { terminalPendingReason } from './new-tab-agent-menu-model'
import { rowId, rowLabel, rowTitle } from './agent-menu-row-presentation'
import { agentCopyMenuRows } from '../../../../../shared/agent-launch/picker/agent-copy-menu-rows'
import type { NativeChatDefaultSettings } from '../../../../../shared/agent-launch/choices/structured-native-chat-launch-route'
import { useShallow } from 'zustand/react/shallow'
import type { AgentPickerEntry } from '../../../../../shared/agent-launch/picker/agent-launch-picker'
import {
  withAgentPickerCopyEntries,
  type AgentPickerCopySettings
} from '../../../../../shared/agent-launch/picker/agent-picker-copy-entries'

/** Saved agent copies of the agents listed here, each offered on the surfaces its agent is. */
export function AgentCopyMenuItems({
  rows,
  detectedIds,
  disabled,
  terminalPending,
  runLaunch
}: {
  rows: readonly NewTabAgentMenuRow[]
  detectedIds: readonly TuiAgent[] | null
  disabled: boolean
  terminalPending: boolean | undefined
  runLaunch: React.ComponentProps<typeof SubscribedAgentLaunchPickerMenu>['runLaunch']
}): React.JSX.Element | null {
  const t = useTranslate()
  const copyRows = agentCopyMenuRows(
    rows,
    useAgentCopiesForMenu(),
    detectedIds,
    useAgentCopyMenuChatSettings()
  )
  if (copyRows.length === 0) {
    return null
  }
  return (
    <>
      <DropdownMenuSeparator />
      {copyRows.map((row) => {
        const label = rowLabel(row, t)
        const pendingReason = terminalPendingReason(terminalPending, row, t)
        return (
          <DropdownMenuItem
            key={rowId(row)}
            variant="launch"
            disabled={disabled || !!pendingReason}
            aria-description={pendingReason}
            onSelect={(event) => {
              if (runLaunch(row) === false) {
                event.preventDefault()
              }
            }}
            title={rowTitle(row, row.copy?.name ?? label, t)}
          >
            <AgentIcon agent={row.agent} size={14} />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {pendingReason ? (
              <span className="min-w-0 shrink truncate text-xs text-muted-foreground">
                {pendingReason}
              </span>
            ) : null}
          </DropdownMenuItem>
        )
      })}
    </>
  )
}

/** The Chat | CLI settings a copy's menu rows follow, read field by field so the menu re-renders
 *  only when they change. */
export function useAgentCopyMenuChatSettings(): NativeChatDefaultSettings {
  const agentDefaultSurface = useAppStateValue((s) => s.settings?.agentDefaultSurface)
  const nativeChatProviders = useAppStateValue((s) => s.settings?.nativeChatProviders)
  return { agentDefaultSurface, nativeChatProviders }
}

/** This desktop's saved copies that are turned on, as their agent is. */
export function useAgentCopiesForMenu(): AgentCopy[] {
  const savedCopies = useAppStateValue((s) => s.settings?.agentCopies)
  const disabledAgents = useAppStateValue((s) => s.settings?.disabledTuiAgents)
  return normalizeAgentCopies(savedCopies).filter(
    (copy) => !copy.disabled && isTuiAgentEnabled(copy.agent, disabledAgents)
  )
}

/** Picker entries with each saved copy listed after its base agent, as its own submenu row. */
export function useAgentPickerEntriesWithCopies(
  entries: AgentPickerEntry[],
  detectedIds: readonly TuiAgent[] | null
): AgentPickerEntry[] {
  const copies = useAgentCopiesForMenu()
  const settings: AgentPickerCopySettings = useAppStateValue(
    useShallow((s) => ({
      agentCopies: s.settings?.agentCopies,
      agentCmdOverrides: s.settings?.agentCmdOverrides,
      agentDefaultArgs: s.settings?.agentDefaultArgs,
      agentDefaultEnv: s.settings?.agentDefaultEnv,
      agentLaunchChoices: s.settings?.agentLaunchChoices,
      agentPermissionDefault: s.settings?.agentPermissionDefault,
      agentPermissionOverrides: s.settings?.agentPermissionOverrides,
      agentDefaultSurface: s.settings?.agentDefaultSurface,
      nativeChatProviders: s.settings?.nativeChatProviders,
      nativeChatSessionOptions: s.settings?.nativeChatSessionOptions,
      nativeChatPermissionMode: s.settings?.nativeChatPermissionMode
    }))
  )
  return withAgentPickerCopyEntries(entries, copies, detectedIds, settings)
}
