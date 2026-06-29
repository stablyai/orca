import { resolveAgentStartupTarget } from '@/lib/agent-startup-target'
import type { AgentStartupShell } from '@/lib/tui-agent-startup'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'

type StartupLaunchHost = {
  connectionId?: string | null
  executionHostId?: string | null
}

export function resolveStartupShellForLaunchHost(
  platform: NodeJS.Platform,
  host: StartupLaunchHost | null | undefined,
  terminalWindowsShell?: string | null,
  projectRuntime?: ProjectExecutionRuntimeResolution
): AgentStartupShell {
  return resolveAgentStartupTarget({
    platform,
    host,
    terminalWindowsShell,
    projectRuntime
  }).shell
}
