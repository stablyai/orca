import { Plus, SquareArrowOutUpRight } from 'lucide-react'
import { AgentStateDot } from '@/components/AgentStateDot'
import { Button } from '@/components/ui/button'
import { PopoverContent } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { AgentIcon, getAgentLabel } from '@/lib/agent-catalog'
import { agentTypeToIconAgent } from '@/lib/agent-status'
import type {
  DashboardCard,
  DashboardRevealWorktreeArgs,
  DashboardSpawnAgentArgs
} from '../../../../shared/dashboard-snapshot'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentMapProjectRing, AgentMapWorktreeRing } from './agent-map-layout'
import { agentMapStatusLabel, agentName, formatDuration } from './agent-map-node-presentation'

type AgentMapWorktreeDetailsCardProps = {
  project: AgentMapProjectRing
  worktree: AgentMapWorktreeRing
  launchableAgents?: readonly TuiAgent[]
  onSelectAgent: (card: DashboardCard) => void
  onRevealWorktree?: (args: DashboardRevealWorktreeArgs) => void
  onSpawnAgent?: (args: DashboardSpawnAgentArgs) => void
  /** Closes the popover once an action has been taken. */
  onDone: () => void
}

/** The worktree ring's popover: what is running in this workspace, plus the
 *  ways out of the map — open the workspace, or start something new in it. */
export function AgentMapWorktreeDetailsCard({
  project,
  worktree,
  launchableAgents,
  onSelectAgent,
  onRevealWorktree,
  onSpawnAgent,
  onDone
}: AgentMapWorktreeDetailsCardProps): React.JSX.Element {
  const activeCount =
    worktree.statusCounts.working + worktree.statusCounts.blocked + worktree.statusCounts.waiting
  const doneCount = worktree.statusCounts.done + worktree.statusCounts['done-seen']
  const openLabel =
    worktree.workspaceKind === 'folder'
      ? translate('dashboardPopout.map.openFolderWorkspaceAction', 'Open folder')
      : translate('dashboardPopout.map.openWorktreeAction', 'Open worktree')
  return (
    <PopoverContent align="center" sideOffset={10} className="w-80 p-0">
      <header className="flex items-start gap-2 border-b border-border px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <span className="block text-[11px] break-words text-muted-foreground">
            {project.name}
          </span>
          <strong className="block text-[13px] break-words">{worktree.name}</strong>
          <span className="mt-1 block text-[11px] text-muted-foreground">
            {translate(
              'dashboardPopout.map.worktreeSummary',
              '{{total}} agents · {{active}} active · {{done}} done',
              {
                count: worktree.agents.length,
                defaultValue_one: '{{total}} agent · {{active}} active · {{done}} done',
                defaultValue_other: '{{total}} agents · {{active}} active · {{done}} done',
                total: worktree.agents.length,
                active: activeCount,
                done: doneCount
              }
            )}
          </span>
        </div>
        {onRevealWorktree ? (
          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            className="shrink-0"
            // Icon-only so a long workspace name keeps the full header width.
            aria-label={openLabel}
            onClick={() => {
              onRevealWorktree({
                worktreeId: worktree.worktreeId,
                executionHostId: worktree.executionHostId
              })
              onDone()
            }}
          >
            <SquareArrowOutUpRight />
          </Button>
        ) : null}
      </header>
      <section className={onSpawnAgent ? 'border-b border-border px-2 py-2' : 'px-2 py-2'}>
        <h3 className="mb-1 px-1 text-[11px] font-semibold text-muted-foreground">
          {translate('dashboardPopout.map.runningAgents', 'Agents')}
        </h3>
        <div className="scrollbar-sleek max-h-56 space-y-0.5 overflow-y-auto">
          {worktree.agents.length === 0 ? (
            <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
              {translate('dashboardPopout.map.noWorkspaceAgents', 'No agents in this workspace.')}
            </p>
          ) : (
            worktree.agents.map((agent) => (
              <button
                key={agent.card.paneKey}
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                onClick={() => {
                  onSelectAgent(agent.card)
                  onDone()
                }}
              >
                <AgentIcon agent={agentTypeToIconAgent(agent.card.agentType)} size={14} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] font-medium break-words">
                    {agentName(agent.card)}
                  </span>
                  <span className="block text-[11px] break-words text-muted-foreground">
                    {agentMapStatusLabel(agent.status)} · {formatDuration(agent.durationMinutes)}
                  </span>
                </span>
                <AgentStateDot
                  state={agent.status === 'done-seen' ? 'done' : agent.status}
                  size="md"
                />
              </button>
            ))
          )}
        </div>
      </section>
      {onSpawnAgent ? (
        <section className="px-3 py-2.5">
          <h3 className="mb-1.5 text-[11px] font-semibold text-muted-foreground">
            {translate('dashboardPopout.map.spawnAgent', 'Start a new agent')}
          </h3>
          {launchableAgents && launchableAgents.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {launchableAgents.map((agent) => (
                <Button
                  key={agent}
                  type="button"
                  variant="outline"
                  size="xs"
                  className="gap-1.5"
                  onClick={() => {
                    onSpawnAgent({ worktreeId: worktree.worktreeId, agent })
                    onDone()
                  }}
                >
                  <Plus className="size-3" />
                  <AgentIcon agent={agent} size={12} />
                  {getAgentLabel(agent)}
                </Button>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              {translate('dashboardPopout.map.noLaunchableAgents', 'No enabled agents detected.')}
            </p>
          )}
        </section>
      ) : null}
    </PopoverContent>
  )
}
