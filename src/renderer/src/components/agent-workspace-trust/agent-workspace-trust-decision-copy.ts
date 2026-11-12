// @protected-copy: per-repository agent folder trust copy.
import { translate } from '@/i18n/i18n'

export const agentWorkspaceTrustDecisionCopy = {
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
