import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type { LaunchPromptPlan } from '../../../shared/launch-prompt-carry'
import type { LaunchFile } from '../../../shared/launch-prompt-file'

/** What a created workspace launches, and the submitted prompt it still owes the agent, if any. */
export type ComposerAgentStartupPlan = AgentStartupPlan & {
  launchFile?: LaunchFile
  /** The submitted prompt the launch carries; handed back to copy if the host refuses the spawn. */
  launchPrompt?: string
  /** A submitted prompt the launch could not carry; pasted once the agent is ready. */
  pastePromptAfterReady?: string
}

export function composerAgentStartupPlan(
  planned: LaunchPromptPlan<AgentStartupPlan> | null,
  prompt: string
): ComposerAgentStartupPlan | null {
  if (!planned) {
    return null
  }
  switch (planned.carry) {
    case 'none':
      return planned.plan
    case 'on-line':
      return { ...planned.plan, launchPrompt: prompt.trim() }
    case 'launch-file':
      return { ...planned.plan, launchFile: planned.launchFile, launchPrompt: prompt.trim() }
    case 'paste-after-ready':
      return { ...planned.cleanPlan, pastePromptAfterReady: planned.text }
  }
}
