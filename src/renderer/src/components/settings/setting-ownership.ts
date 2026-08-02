import { translate } from '@/i18n/i18n'

export type SettingOwnership =
  | 'client-default'
  | 'host-override'
  | 'project-host-setup'
  | 'provider-host'

type SettingOwnershipSummary = {
  ownership: SettingOwnership
  label: string
  description: string
}

function buildSummaries(): Record<string, SettingOwnershipSummary> {
  return {
    sourceControlAiDefaults: {
      ownership: 'client-default',
      label: translate('auto.components.settings.settingOwnership.clientDefault', 'Client default'),
      description: translate(
        'auto.components.settings.settingOwnership.sourceControlAiDefaults',
        'Recipes, prompts, and hosted-review defaults are shared by this client; model choices and discovery stay scoped to the host where the agent runs.'
      )
    },
    repositorySourceControlAi: {
      ownership: 'project-host-setup',
      label: translate(
        'auto.components.settings.settingOwnership.projectOnThisHost',
        'Project on this host'
      ),
      description: translate(
        'auto.components.settings.settingOwnership.repositorySourceControlAi',
        'These overrides apply to this project setup and inherit the client Source Control AI defaults until customized.'
      )
    },
    agentLaunchDefaults: {
      ownership: 'client-default',
      label: translate('auto.components.settings.settingOwnership.clientDefault', 'Client default'),
      description: translate(
        'auto.components.settings.settingOwnership.agentLaunchDefaults',
        'Default agent, command overrides, CLI arguments, and launch environment are client preferences. SSH and remote server launches still validate host availability at run time.'
      )
    },
    terminalQuickCommands: {
      ownership: 'client-default',
      label: translate(
        'auto.components.settings.settingOwnership.clientDefaultProjectScopes',
        'Client default + project scopes'
      ),
      description: translate(
        'auto.components.settings.settingOwnership.terminalQuickCommands',
        'Commands are saved on this client, then scoped globally or to a project setup so they run from the selected terminal context.'
      )
    },
    workspaceDirectory: {
      ownership: 'host-override',
      label: translate('auto.components.settings.settingOwnership.hostOverride', 'Host override'),
      description: translate(
        'auto.components.settings.settingOwnership.workspaceDirectory',
        'The client default is inherited until a host needs its own worktree directory.'
      )
    },
    providerAccounts: {
      ownership: 'provider-host',
      label: translate('auto.components.settings.settingOwnership.providerHost', 'Provider host'),
      description: translate(
        'auto.components.settings.settingOwnership.providerAccounts',
        'Credentials and account checks belong to the local client or selected remote server that owns the provider integration.'
      )
    }
  }
}

const SUMMARY_KEYS = [
  'sourceControlAiDefaults',
  'repositorySourceControlAi',
  'agentLaunchDefaults',
  'terminalQuickCommands',
  'workspaceDirectory',
  'providerAccounts'
] as const

export type SettingOwnershipKey = (typeof SUMMARY_KEYS)[number]

export function getSettingOwnershipSummary(key: SettingOwnershipKey): SettingOwnershipSummary {
  return buildSummaries()[key]
}
