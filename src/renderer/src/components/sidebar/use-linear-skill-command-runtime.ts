import { useMemo } from 'react'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
import { isWebClientLocation } from '@/lib/web-client-location'
import {
  getCurrentPlatform,
  getLinearPromptAgentRuntime,
  resolveLinearSkillCommandPlatform,
  type LinearAgentSkillPromptSettings
} from './linear-agent-skill-runtime'

export function useLinearSkillCommandRuntime(args: {
  currentPlatform?: NodeJS.Platform
  projectRuntime?: ProjectExecutionRuntimeResolution
  remote: boolean
  settings?: LinearAgentSkillPromptSettings | null
}): {
  agentRuntime: ReturnType<typeof getLinearPromptAgentRuntime>
  executionHostPlatform?: NodeJS.Platform
} {
  const activeSkillRuntime = useActiveProjectSkillRuntime()
  const webClient = isWebClientLocation()
  const executionHostPlatform = resolveLinearSkillCommandPlatform({
    explicitPlatform: args.currentPlatform,
    executionHostPlatform: activeSkillRuntime.executionHostPlatform,
    remote: args.remote,
    webClient,
    viewerPlatform: getCurrentPlatform()
  })
  const executionHostRuntime = args.currentPlatform ? undefined : activeSkillRuntime.agentRuntime
  const agentRuntime = useMemo(
    () =>
      getLinearPromptAgentRuntime(
        args.settings,
        executionHostPlatform,
        args.remote,
        args.projectRuntime,
        executionHostRuntime
      ),
    [args.projectRuntime, args.remote, args.settings, executionHostPlatform, executionHostRuntime]
  )
  return { agentRuntime, executionHostPlatform }
}
