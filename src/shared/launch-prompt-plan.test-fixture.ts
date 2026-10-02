import type { LaunchFile } from './launch-prompt-file'
import { describeLaunchHost } from './launch-host'
import type { LaunchPromptCarry } from './launch-prompt-carry'
import {
  planLaunchPrompt,
  type AgentLaunchPromptArgs,
  type AgentStartupPlan
} from './tui-agent-startup'

/** A prompted plan flattened for tests that assert on the line it builds. */
export type PlannedLaunchForTest = AgentStartupPlan & {
  carry: LaunchPromptCarry
  launchFile?: LaunchFile
  /** The prompt left for the paste after ready; null when the launch carried it. */
  pasteAfterReady: string | null
}

/** `planLaunchPrompt`, flattened; null where it answers null, or for an empty prompt unless
 *  `allowEmptyPromptLaunch`, as the builder did before the outcome was explicit. */
export function planLaunchForTest(
  args: Omit<AgentLaunchPromptArgs, 'host' | 'paste'> &
    Partial<Pick<AgentLaunchPromptArgs, 'host' | 'paste'>> & {
      allowEmptyPromptLaunch?: boolean
    }
): PlannedLaunchForTest | null {
  const { allowEmptyPromptLaunch, ...launchArgs } = args
  if (allowEmptyPromptLaunch !== true && !args.prompt.trim()) {
    return null
  }
  const planned = planLaunchPrompt({
    ...launchArgs,
    // A local launch on the platform under test, with #24257's guarded paste, unless the test says.
    host:
      args.host ??
      describeLaunchHost({
        launchPlatform: args.platform,
        isRemote: args.isRemote === true,
        hostPlatform: args.platform,
        paired: false
      }),
    paste: args.paste ?? 'when-host-proves-agent'
  })
  if (!planned) {
    return null
  }
  switch (planned.carry) {
    case 'none':
    case 'on-line':
      return { ...planned.plan, carry: planned.carry, pasteAfterReady: null }
    case 'launch-file':
      return {
        ...planned.plan,
        carry: planned.carry,
        launchFile: planned.launchFile,
        pasteAfterReady: null
      }
    case 'paste-after-ready':
      return { ...planned.cleanPlan, carry: planned.carry, pasteAfterReady: planned.text }
  }
}
