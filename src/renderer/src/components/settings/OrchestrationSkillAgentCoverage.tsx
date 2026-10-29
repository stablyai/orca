import type { BundledSkillObserved, BundledSkillPlan } from '../../../../shared/bundled-skill-plan'
import type { DiscoveredSkill, SkillDiscoverySource } from '../../../../shared/skills'
import type { OrchestrationSkillAgentStatus } from '@/lib/orchestration-skill-coverage'
import { AgentIcon, getAgentLabel } from '@/lib/agent-catalog'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import {
  getOrchestrationSkillAgentStatuses,
  sortOrchestrationAgents
} from '@/lib/orchestration-skill-coverage'
import { ORCHESTRATION_SKILL_NAME } from '@/lib/agent-feature-skill-names'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

type AgentCoverageStatus = OrchestrationSkillAgentStatus & { needsAttention?: boolean }

function skillReadFailed(observed: BundledSkillObserved | undefined): boolean {
  return (
    observed?.kind === 'unreadable' ||
    (observed?.kind === 'folder' &&
      observed.entries.includes('SKILL.md:file') &&
      observed.skillDigest === null)
  )
}

function getAgentCoverageSummary(props: {
  loading: boolean
  totalCount: number
  installedCount: number
  fullCoverage: boolean
  noCoverage: boolean
}): string {
  const { loading, totalCount, installedCount, fullCoverage, noCoverage } = props

  if (loading) {
    return translate(
      'auto.components.settings.OrchestrationSkillAgentCoverage.checking',
      'Checking installed agents and skill paths…'
    )
  }
  if (totalCount === 0) {
    return translate(
      'auto.components.settings.OrchestrationSkillAgentCoverage.noAgents',
      'No agent CLIs detected on PATH. Install agents in Settings → Agents, then re-check.'
    )
  }
  if (fullCoverage) {
    return totalCount === 1
      ? translate(
          'auto.components.settings.OrchestrationSkillAgentCoverage.fullCoverage_one',
          'All 1 detected agent has the skill.',
          { value0: totalCount, count: totalCount }
        )
      : translate(
          'auto.components.settings.OrchestrationSkillAgentCoverage.fullCoverage_other',
          'All {{value0}} detected agents have the skill.',
          { value0: totalCount, count: totalCount }
        )
  }
  if (noCoverage) {
    return translate(
      'auto.components.settings.OrchestrationSkillAgentCoverage.noCoverage',
      'Install the skill above, then re-check.'
    )
  }
  return translate(
    'auto.components.settings.OrchestrationSkillAgentCoverage.partialCoverage',
    '{{value0}} of {{value1}} detected agents have the skill.',
    { value0: installedCount, value1: totalCount }
  )
}

function AgentCoverageChip({ status }: { status: AgentCoverageStatus }): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs',
        status.installed
          ? 'border-status-success-border bg-status-success-background text-foreground'
          : 'border-border/60 bg-muted/20 text-muted-foreground'
      )}
    >
      <AgentIcon agent={status.agent} size={12} />
      <span className="font-medium text-foreground">{status.label}</span>
      <span
        className={cn(
          'text-[10px] font-medium',
          status.installed ? 'text-status-success' : 'text-muted-foreground'
        )}
      >
        {status.needsAttention
          ? translate('auto.components.skills.skillPlanOpCopy.needsAttention', 'Needs attention')
          : status.installed
            ? translate(
                'auto.components.settings.OrchestrationSkillAgentCoverage.1e8f8d8fae',
                'Ready'
              )
            : translate(
                'auto.components.settings.OrchestrationSkillAgentCoverage.ffe13e36fb',
                'Missing'
              )}
      </span>
    </span>
  )
}

export function OrchestrationSkillAgentCoverage(props: {
  plan?: BundledSkillPlan
  skills: readonly DiscoveredSkill[]
  sources: readonly SkillDiscoverySource[]
  loading: boolean
  embedded?: boolean
  className?: string
}): React.JSX.Element {
  const { skills, sources, loading: skillsLoading, embedded = false, className } = props
  const { detectedIds, isLoading: agentsLoading } = useDetectedAgents(
    props.plan ? undefined : { kind: 'local' }
  )
  const loading = !props.plan && (skillsLoading || agentsLoading || detectedIds === null)
  const ops = props.plan?.skills.find((skill) => skill.name === ORCHESTRATION_SKILL_NAME)?.ops ?? []
  const plannedAgents = sortOrchestrationAgents([...new Set(ops.flatMap((op) => op.agents))])
  const shared = ops.find((op) => op.role === 'shared')?.observed
  const readableShared = shared?.kind === 'folder' && shared.skillDigest !== null
  const agentStatuses: AgentCoverageStatus[] = props.plan
    ? plannedAgents.map((agent) => {
        const agentOps = ops.filter((op) => op.agents.some((provider) => provider === agent))
        const installed = agentOps.some(
          (op) =>
            op.kind === 'keep' ||
            (op.observed.kind === 'folder' && op.observed.skillDigest !== null) ||
            (op.observed.kind === 'link' && op.reason === 'shared-not-current' && readableShared)
        )
        return {
          agent,
          label: getAgentLabel(agent),
          installed,
          needsAttention:
            !installed &&
            agentOps.some(
              (op) =>
                skillReadFailed(op.observed) ||
                (op.observed.kind === 'link' &&
                  op.reason === 'shared-not-current' &&
                  skillReadFailed(shared))
            )
        }
      })
    : getOrchestrationSkillAgentStatuses(skills, detectedIds ?? [], sources)
  const installedCount = agentStatuses.filter((status) => status.installed).length
  const totalCount = agentStatuses.length
  const fullCoverage = !loading && totalCount > 0 && installedCount === totalCount
  const noCoverage = !loading && totalCount > 0 && installedCount === 0
  const showAgentChips = !loading && totalCount > 0 && !fullCoverage
  const summary = getAgentCoverageSummary({
    loading,
    totalCount,
    installedCount,
    fullCoverage,
    noCoverage
  })

  return (
    <div
      className={cn(
        embedded ? 'space-y-2.5' : 'space-y-4 border-t border-border/60 pt-6',
        className
      )}
    >
      <div className="space-y-1">
        <h3 className="text-sm font-medium text-foreground">
          {translate(
            'auto.components.settings.OrchestrationSkillAgentCoverage.6dec5ce2d2',
            'Agent coverage'
          )}
        </h3>
        <p className="text-xs leading-relaxed text-muted-foreground">{summary}</p>
      </div>

      {showAgentChips ? (
        <div className="flex flex-wrap gap-1.5">
          {agentStatuses.map((status) => (
            <AgentCoverageChip key={status.agent} status={status} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
