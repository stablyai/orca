import { useEffect, useMemo } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import type { AgentDetectionTarget } from '@/lib/agent-session/launch/inventory/useDetectedAgents'
import { agentCliUpdateHostTarget } from '@/store/slices/runtime-host-updates/agent-cli-updates'
import { useAgentCliUpdate } from './use-agent-cli-update'
import { AgentCliUpdateFailedChip } from './AgentCliUpdateFailedChip'

// WSL distros and direct SSH hosts aren't checked; Orca's own server there would run the update.
function updateHostKey(target: AgentDetectionTarget): string | null {
  return target.kind === 'runtime'
    ? target.environmentId
    : target.kind === 'local' && !target.contextKey
      ? ''
      : null
}

/** Settings' Update for the user's own CLI on `target`; renders nothing while it is current. */
export function AgentCliUpdateButton({
  detectionTarget,
  agent
}: {
  detectionTarget: AgentDetectionTarget
  agent: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const hostKey = updateHostKey(detectionTarget)
  const target = useMemo(
    () => (hostKey === null ? null : agentCliUpdateHostTarget(hostKey)),
    [hostKey]
  )
  const { update, run, start, openFailure } = useAgentCliUpdate(target, agent)
  const checkAgentCliUpdates = useAppStore((s) => s.checkAgentCliUpdates)
  // Opening Settings on a host counts as using it; the host answers from its cache.
  useEffect(() => {
    if (target) {
      void checkAgentCliUpdates(target)
    }
  }, [checkAgentCliUpdates, target])
  if (!update?.runnable) {
    return null
  }
  if (run?.phase === 'failed') {
    return (
      <span className="flex items-center gap-1.5">
        <AgentCliUpdateFailedChip onOpen={() => openFailure()} />
        <Button type="button" variant="outline" size="xs" onClick={() => void start()}>
          {t('agentCliUpdate.tryAgain', 'Try again')}
        </Button>
      </span>
    )
  }
  const running = run?.phase === 'running'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={running}
          onClick={() => void start()}
        >
          {running ? <Loader2 className="animate-spin" /> : null}
          {running
            ? t('agentCliUpdate.updating', 'Updating…')
            : t('agentCliUpdate.update', 'Update')}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {t('agentCliUpdate.versions', '{{installed}} → {{latest}}', {
          installed: update.installedVersion,
          latest: update.latestVersion
        })}
      </TooltipContent>
    </Tooltip>
  )
}
