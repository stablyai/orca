import type { GlobalSettings } from '../../../settings/global-settings-types'

/** The settings a client sends with a generation call so its own Source Control AI picks the agent, not the host's. */
export type CommitMessageGenerationSettings = Partial<
  Pick<
    GlobalSettings,
    'commitMessageAi' | 'sourceControlAi' | 'agentCmdOverrides' | 'defaultTuiAgent'
  >
>

export function pickCommitMessageGenerationSettings(
  settings: CommitMessageGenerationSettings
): CommitMessageGenerationSettings {
  return {
    ...(settings.commitMessageAi !== undefined
      ? { commitMessageAi: settings.commitMessageAi }
      : {}),
    ...(settings.sourceControlAi !== undefined
      ? { sourceControlAi: settings.sourceControlAi }
      : {}),
    ...(settings.agentCmdOverrides !== undefined
      ? { agentCmdOverrides: settings.agentCmdOverrides }
      : {}),
    // Why: hosts before the contract accepted 'blank' reject it; null picks the same fallback agent.
    ...(settings.defaultTuiAgent !== undefined
      ? { defaultTuiAgent: settings.defaultTuiAgent === 'blank' ? null : settings.defaultTuiAgent }
      : {})
  }
}
