import { useAppStateValue } from '@/store/retained-views/app-state-view'
import { useTranslate } from '@/i18n/use-translate'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import type { SubscribedAgentLaunchPickerMenu } from '@/components/agent/AgentLaunchPickerMenu'
import { normalizeAgentCopies } from '../../../../../shared/agent-launch/catalog/agent-copies'
import { isTuiAgentEnabled } from '../../../../../shared/agent-launch/catalog/tui-agent-selection'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { NewTabAgentMenuRow } from '../../../../../shared/agent-launch/picker/agent-launch-picker-rows'
import { terminalPendingReason } from './new-tab-agent-menu-model'
import { rowTitle } from './agent-menu-row-presentation'

/** Saved agent copies whose agent is installed here; each opens a terminal with its own setup. */
export function AgentCopyMenuItems({
  detectedIds,
  disabled,
  terminalPending,
  runLaunch
}: {
  detectedIds: readonly TuiAgent[] | null
  disabled: boolean
  terminalPending: boolean | undefined
  runLaunch: React.ComponentProps<typeof SubscribedAgentLaunchPickerMenu>['runLaunch']
}): React.JSX.Element | null {
  const t = useTranslate()
  const savedCopies = useAppStateValue((s) => s.settings?.agentCopies)
  const disabledAgents = useAppStateValue((s) => s.settings?.disabledTuiAgents)
  const copies = normalizeAgentCopies(savedCopies).filter(
    (copy) => detectedIds?.includes(copy.agent) && isTuiAgentEnabled(copy.agent, disabledAgents)
  )
  if (copies.length === 0) {
    return null
  }
  return (
    <>
      <DropdownMenuSeparator />
      {copies.map((copy) => {
        const row: NewTabAgentMenuRow = {
          kind: 'terminal',
          agent: copy.agent,
          copy: { id: copy.id, name: copy.name }
        }
        const pendingReason = terminalPendingReason(terminalPending, row, t)
        return (
          <DropdownMenuItem
            key={copy.id}
            variant="launch"
            disabled={disabled || !!pendingReason}
            aria-description={pendingReason}
            onSelect={(event) => {
              if (runLaunch(row) === false) {
                event.preventDefault()
              }
            }}
            title={rowTitle(row, copy.name, t)}
          >
            <AgentIcon agent={copy.agent} size={14} />
            <span className="min-w-0 flex-1 truncate">{copy.name}</span>
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
