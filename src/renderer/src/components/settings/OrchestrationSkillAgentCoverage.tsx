import type { DiscoveredSkill, SkillDiscoverySource } from '../../../../shared/skills'
import type { OrchestrationSkillAgentStatus } from '@/lib/orchestration-skill-coverage'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { RefreshCw } from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import { useActiveSkillDiscoveryRuntimeTarget } from '@/hooks/use-active-skill-discovery-runtime-target'
import { useDetectedAgents, type AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import { getOrchestrationSkillAgentStatuses } from '@/lib/orchestration-skill-coverage'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'

function toAgentDetectionTarget(
  target: RuntimeClientTarget | null
): AgentDetectionTarget | undefined {
  if (target === null) {
    // Why: undefined keeps detection loading (detectedIds null) until the scan
    // host resolves, instead of flashing local agents for a remote runtime.
    return undefined
  }
  switch (target.kind) {
    case 'environment':
      return { kind: 'runtime', environmentId: target.environmentId }
    case 'local':
      return { kind: 'local' }
    default: {
      // Why: a future RuntimeClientTarget kind must not silently fall back to
      // local detection — that is the host mismatch this mapping exists to fix.
      const exhaustive: never = target
      void exhaustive
      return undefined
    }
  }
}

function getAgentCoverageSummary(props: {
  loading: boolean
  detectionFailed: boolean
  totalCount: number
  installedCount: number
  fullCoverage: boolean
  noCoverage: boolean
}): string {
  const { loading, detectionFailed, totalCount, installedCount, fullCoverage, noCoverage } = props

  if (loading) {
    return 'Checking installed agents and skill paths…'
  }
  if (detectionFailed) {
    return 'Couldn’t reach the host to check installed agents.'
  }
  if (totalCount === 0) {
    return 'No agent CLIs detected on PATH. Install agents in Settings → Agents, then re-check.'
  }
  if (fullCoverage) {
    return `All ${totalCount} detected agents have the skill.`
  }
  if (noCoverage) {
    return 'Install the skill above, then re-check.'
  }
  return `${installedCount} of ${totalCount} detected agents have the skill.`
}

function AgentCoverageChip({
  status
}: {
  status: OrchestrationSkillAgentStatus
}): React.JSX.Element {
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
        {status.installed
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
  skills: readonly DiscoveredSkill[]
  sources: readonly SkillDiscoverySource[]
  loading: boolean
  embedded?: boolean
  className?: string
}): React.JSX.Element {
  const { skills, sources, loading: skillsLoading, embedded = false, className } = props
  // Why: skills/sources come from the runtime-scoped scan (#6887); detect agents
  // on that same host or remote skill roots get matched against local agent ids.
  const runtimeTarget = useActiveSkillDiscoveryRuntimeTarget()
  const {
    detectedIds,
    isLoading: agentsLoading,
    detectionFailed,
    refresh
  } = useDetectedAgents(toAgentDetectionTarget(runtimeTarget))
  // Why: a failed remote probe never writes detectedIds, so gating on null alone
  // would pin the card on "Checking…" forever with no retry.
  const loading = skillsLoading || agentsLoading || (detectedIds === null && !detectionFailed)
  const agentStatuses = getOrchestrationSkillAgentStatuses(skills, detectedIds ?? [], sources)
  const installedCount = agentStatuses.filter((status) => status.installed).length
  const totalCount = agentStatuses.length
  const resolved = !loading && !detectionFailed
  const fullCoverage = resolved && totalCount > 0 && installedCount === totalCount
  const noCoverage = resolved && totalCount > 0 && installedCount === 0
  const showAgentChips = resolved && totalCount > 0 && !fullCoverage
  const summary = getAgentCoverageSummary({
    loading,
    detectionFailed,
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

      {detectionFailed ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => void refresh()}
          className="h-6 gap-1.5 px-2"
        >
          <RefreshCw className="size-3" />
          {translate(
            'auto.components.settings.OrchestrationSkillAgentCoverage.retryDetection',
            'Retry'
          )}
        </Button>
      ) : null}

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
