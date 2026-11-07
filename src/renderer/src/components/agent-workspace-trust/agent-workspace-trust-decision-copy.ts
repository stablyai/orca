// @protected-copy: per-repository agent folder trust copy.
import { translate } from '@/i18n/i18n'

export const agentWorkspaceTrustDecisionCopy = {
  promptTitle: (repo: string) =>
    translate(
      'auto.components.agent-workspace-trust-decision.prompt-title',
      'Trust {{repo}} for agents?',
      { repo }
    ),
  promptDescription: () =>
    translate(
      'auto.components.agent-workspace-trust-decision.prompt-description',
      'Agents like Claude Code and Codex ask "Do you trust this folder?" before they load the project\'s own agent settings and hooks, which can run commands. Orca can answer yes for you in every worktree of this repository.'
    ),
  promptRemembered: () =>
    translate(
      'auto.components.agent-workspace-trust-decision.prompt-remembered',
      "Orca remembers your answer for this repository. You can change it in the repository's settings."
    ),
  trustRepository: () =>
    translate(
      'auto.components.agent-workspace-trust-decision.trust-repository',
      'Trust repository'
    ),
  letAgentsAsk: () =>
    translate('auto.components.agent-workspace-trust-decision.let-agents-ask', 'Let agents ask'),
  settingTitle: () =>
    translate('auto.components.agent-workspace-trust-decision.setting-title', 'Agent Folder Trust'),
  settingDescription: () =>
    translate(
      'auto.components.agent-workspace-trust-decision.setting-description',
      'Whether agents Orca starts in this repository\'s worktrees skip their "Do you trust this folder?" prompt and load the project\'s agent settings and hooks right away.'
    ),
  settingUndecided: () =>
    translate(
      'auto.components.agent-workspace-trust-decision.setting-undecided',
      'Not decided yet. Orca will ask the next time you start an agent here.'
    ),
  settingGlobalOff: () =>
    translate(
      'auto.components.agent-workspace-trust-decision.setting-global-off',
      'Folder trust is turned off in Agents settings, so agents always ask.'
    ),
  settingKeywordTrust: () =>
    translate('auto.components.agent-workspace-trust-decision.keyword-trust', 'trust'),
  settingKeywordHooks: () =>
    translate('auto.components.agent-workspace-trust-decision.keyword-hooks', 'hooks')
}
