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

const SUMMARIES = {
  sourceControlAiDefaults: {
    ownership: 'client-default',
    label: 'Client default',
    description:
      'Recipes, prompts, and hosted-review defaults are shared by this client; model choices and discovery stay scoped to the host where the agent runs.'
  },
  repositorySourceControlAi: {
    ownership: 'project-host-setup',
    label: 'Project on this host',
    description:
      'These overrides apply to this project setup and inherit the client Source Control AI defaults until customized.'
  },
  agentLaunchDefaults: {
    ownership: 'client-default',
    label: 'Client default',
    description:
      'Default agent, command overrides, CLI arguments, and launch environment are client preferences. SSH and remote server launches still validate host availability at run time.'
  },
  terminalQuickCommands: {
    ownership: 'client-default',
    label: 'Client default + project scopes',
    description:
      'Commands are saved on this client, then scoped globally or to a project setup so they run from the selected terminal context.'
  },
  workspaceDirectory: {
    ownership: 'host-override',
    label: 'Host override',
    description: 'The client default is inherited until a host needs its own worktree directory.'
  },
  providerAccounts: {
    ownership: 'provider-host',
    label: 'Provider host',
    description:
      'Credentials and account checks belong to the local client or selected remote server that owns the provider integration.'
  }
} satisfies Record<string, SettingOwnershipSummary>

export type SettingOwnershipKey = keyof typeof SUMMARIES

export function getSettingOwnershipSummary(key: SettingOwnershipKey): SettingOwnershipSummary {
  return SUMMARIES[key]
}
