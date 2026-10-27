import { useMemo, useState, useSyncExternalStore } from 'react'
import { ChevronDown, RotateCcw } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { AgentSessionRestartCommandDialog } from './AgentSessionRestartCommandDialog'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  agentSessionRestartSkipMessage,
  formatAgentSessionRestartRowLabel,
  formatRestartAllAgentsLabel,
  type AgentSessionRestartTarget,
  type AgentSessionRestartMenuRow
} from '@/lib/agent-session-restart-plan'
import {
  formatAgentSessionRestartOutcome,
  summarizeAgentSessionRestartOutcomes,
  type AgentSessionRestartOutcome
} from '@/lib/agent-session-restart-run'
import {
  collectAgentSessionRestartPlanFromState,
  getAgentSessionRestartController
} from '@/lib/agent-session-restart-service'

const NO_COMMAND_PANES: readonly AgentSessionRestartTarget[] = []
const NO_UNAVAILABLE: readonly string[] = []

export function AgentSessionRestartMenu(): React.JSX.Element {
  const tabsByWorktree = useAppStore((state) => state.tabsByWorktree)
  const terminalLayoutsByTabId = useAppStore((state) => state.terminalLayoutsByTabId)
  const ptyIdsByTabId = useAppStore((state) => state.ptyIdsByTabId)
  const agentStatusByPaneKey = useAppStore((state) => state.agentStatusByPaneKey)
  const launchConfigs = useAppStore((state) => state.agentLaunchConfigByPaneKey)
  const sleepingSessions = useAppStore((state) => state.sleepingAgentSessionsByPaneKey)
  const disabledTuiAgents = useAppStore((state) => state.settings?.disabledTuiAgents)
  const plan = useMemo(() => {
    // The subscribed snapshots are the rerender inputs. Collection reads the same store.
    void tabsByWorktree
    void terminalLayoutsByTabId
    void ptyIdsByTabId
    void agentStatusByPaneKey
    void disabledTuiAgents
    void launchConfigs
    void sleepingSessions
    return collectAgentSessionRestartPlanFromState(useAppStore.getState())
  }, [
    tabsByWorktree,
    terminalLayoutsByTabId,
    ptyIdsByTabId,
    agentStatusByPaneKey,
    disabledTuiAgents,
    launchConfigs,
    sleepingSessions
  ])
  const [commandTarget, setCommandTarget] = useState<AgentSessionRestartTarget | null>(null)
  const controller = getAgentSessionRestartController()
  const report = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const otherHostSkipped = plan.targets.some(
    (target) =>
      target.kind === 'skipped' &&
      (target.reason === 'remote-unsupported' || target.reason === 'unknown-host')
  )

  return (
    <>
      <AgentSessionRestartMenuView
        commandPanes={plan.targets.filter(
          (target) =>
            target.kind === 'skipped' &&
            (target.reason === 'unknown-launch' ||
              target.reason === 'missing-session' ||
              target.reason === 'resume-unavailable')
        )}
        onCommandRestart={setCommandTarget}
        rows={plan.rows}
        unavailable={plan.targets.flatMap((target) =>
          target.kind === 'skipped'
            ? [`${target.label}: ${agentSessionRestartSkipMessage(target.reason)}`]
            : []
        )}
        restartAllCount={plan.restartAllCount}
        outcomes={report.outcomes}
        running={report.running}
        hostNote={
          plan.restartAllCount === 0 && otherHostSkipped
            ? translate(
                'settings.manageSessions.restartOtherHost',
                'This computer cannot replace agents on another host, so those sessions were left running.'
              )
            : null
        }
        onDismiss={controller.dismiss}
        onRestart={(agent) => {
          void controller.request(agent).catch((error: unknown) => {
            console.warn('[session-restart] request failed:', error)
          })
        }}
      />
      {commandTarget ? (
        <AgentSessionRestartCommandDialog
          target={commandTarget}
          onClose={() => setCommandTarget(null)}
        />
      ) : null}
    </>
  )
}

export function AgentSessionRestartMenuView({
  rows,
  restartAllCount,
  outcomes,
  running,
  hostNote = null,
  unavailable = NO_UNAVAILABLE,
  menuOpen,
  onRestart,
  onDismiss,
  commandPanes = NO_COMMAND_PANES,
  onCommandRestart
}: {
  rows: readonly AgentSessionRestartMenuRow[]
  restartAllCount: number
  outcomes: readonly AgentSessionRestartOutcome[]
  running: boolean
  hostNote?: string | null
  unavailable?: readonly string[]
  menuOpen?: boolean
  onRestart: (agent: TuiAgent | 'all') => void
  onDismiss?: () => void
  commandPanes?: readonly AgentSessionRestartTarget[]
  onCommandRestart?: (target: AgentSessionRestartTarget) => void
}): React.JSX.Element {
  const summary = summarizeAgentSessionRestartOutcomes(outcomes)
  return (
    <div className="space-y-2" data-testid="agent-session-restart">
      <DropdownMenu open={menuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="xs"
            data-testid="agent-session-restart-trigger"
          >
            <RotateCcw />
            {translate('settings.manageSessions.restartAgents', 'Restart agents')}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuItem
            disabled={running || restartAllCount === 0}
            data-testid="agent-session-restart-all"
            onSelect={() => onRestart('all')}
          >
            {formatRestartAllAgentsLabel(restartAllCount)}
          </DropdownMenuItem>
          {rows.map((row) => (
            <DropdownMenuItem
              key={row.agent}
              disabled={running || row.disabled}
              data-testid={`agent-session-restart-${row.agent}`}
              onSelect={() => onRestart(row.agent)}
            >
              {formatAgentSessionRestartRowLabel(row)}
            </DropdownMenuItem>
          ))}
          {commandPanes.length > 0 && onCommandRestart ? <DropdownMenuSeparator /> : null}
          {onCommandRestart
            ? commandPanes.map((target) => (
                <DropdownMenuItem
                  key={target.pane.ptyId}
                  disabled={running}
                  onSelect={() => onCommandRestart(target)}
                >
                  {translate(
                    'settings.manageSessions.commandMenu',
                    'Restart {{agent}} with command…',
                    { agent: target.label }
                  )}
                </DropdownMenuItem>
              ))
            : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {hostNote ? (
        <p className="text-xs text-muted-foreground" data-testid="agent-session-restart-host-note">
          {hostNote}
        </p>
      ) : null}
      {summary ? (
        <Collapsible>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span role="status" data-testid="agent-session-restart-summary">
              {summary}
            </span>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="xs">
                {translate('settings.manageSessions.restartDetails', 'Details')}
                <ChevronDown className="size-3" />
              </Button>
            </CollapsibleTrigger>
            {onDismiss && !running ? (
              <Button variant="ghost" size="xs" onClick={onDismiss}>
                {translate('settings.manageSessions.dismissRestartResults', 'Dismiss')}
              </Button>
            ) : null}
          </div>
          <CollapsibleContent>
            <ul
              className="text-xs text-muted-foreground max-h-48 space-y-1 overflow-y-auto scrollbar-sleek py-2"
              data-testid="agent-session-restart-results"
            >
              {outcomes.map((outcome) => (
                <li key={outcome.ptyId}>{formatAgentSessionRestartOutcome(outcome)}</li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      ) : unavailable.length > 0 ? (
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="xs">
              {translate('settings.manageSessions.restartAvailability', 'Restart availability')}
              <ChevronDown className="size-3" />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul
              className="text-xs text-muted-foreground max-h-48 space-y-1 overflow-y-auto scrollbar-sleek py-2"
              data-testid="agent-session-restart-unavailable"
            >
              {unavailable.map((message, index) => (
                <li key={`${index}:${message}`}>{message}</li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  )
}
