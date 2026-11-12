import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export const getOrcaCloudBillingSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.billing.title', 'Plan & billing'),
    description: translate(
      'settings.orcaCloud.billing.searchDescription',
      'Your Orca Cloud plan, sandbox hours, overage and payment.'
    ),
    keywords: [
      ...translateSearchKeyword('settings.orcaCloud.billing.keywordPlan', 'plan'),
      ...translateSearchKeyword('settings.orcaCloud.billing.keywordBilling', 'billing'),
      ...translateSearchKeyword('settings.orcaCloud.billing.keywordInvoice', 'invoice'),
      ...translateSearchKeyword('settings.orcaCloud.billing.keywordUsage', 'usage'),
      ...translateSearchKeyword('settings.orcaCloud.billing.keywordOverage', 'overage')
    ]
  }
])

export const getOrcaCloudTeamSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.billing.team.title', 'Team'),
    description: translate(
      'settings.orcaCloud.team.searchDescription',
      'Members, invites and seats for your Orca Cloud team.'
    ),
    keywords: [
      ...translateSearchKeyword('settings.orcaCloud.team.keywordMembers', 'members'),
      ...translateSearchKeyword('settings.orcaCloud.team.keywordInvite', 'invite'),
      ...translateSearchKeyword('settings.orcaCloud.team.keywordSeats', 'seats')
    ]
  }
])

export const getOrcaCloudSecretsSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('cloudSecrets.title', 'Cloud secrets'),
    description: translate(
      'cloudSecrets.searchDescription',
      'Environment variables and agent keys for Orca Cloud workspaces: personal, shared with your team, or per repository.'
    ),
    keywords: [
      ...translateSearchKeyword('cloudSecrets.keywordSecret', 'secret'),
      ...translateSearchKeyword('cloudSecrets.keywordEnv', 'environment variable'),
      ...translateSearchKeyword('cloudSecrets.keywordDotenv', '.env'),
      ...translateSearchKeyword('cloudSecrets.keywordApiKey', 'api key'),
      ...translateSearchKeyword('cloudSecrets.keywordGateway', 'ai gateway')
    ]
  }
])

export const getOrcaCloudEnvironmentsSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('settings.orcaCloud.environments.title', 'Cloud environments'),
    description: translate(
      'settings.orcaCloud.environments.searchDescriptionSaved',
      'Repositories and install script built into a saved environment, and waking cloud workspaces before you open them.'
    ),
    keywords: [
      ...translateSearchKeyword('settings.orcaCloud.environments.keywordSnapshot', 'snapshot'),
      ...translateSearchKeyword('settings.orcaCloud.environments.keywordInstall', 'install script'),
      ...translateSearchKeyword('settings.orcaCloud.environments.keywordWake', 'wake'),
      ...translateSearchKeyword('settings.orcaCloud.environments.keywordSandbox', 'sandbox')
    ]
  }
])

export const getOrcaCloudMcpSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('cloudMcpSync.title', 'MCP servers'),
    description: translate(
      'settings.orcaCloud.mcp.searchDescription',
      'Choose which MCP servers from this computer sync to your cloud workspaces.'
    ),
    keywords: [
      ...translateSearchKeyword('settings.orcaCloud.mcp.keywordMcp', 'mcp'),
      ...translateSearchKeyword('settings.orcaCloud.mcp.keywordSync', 'sync'),
      ...translateSearchKeyword('settings.orcaCloud.mcp.keywordCloud', 'cloud')
    ]
  }
])

export const getOrcaCloudLocalCommandsSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('localCommands.settings.title', 'Commands on this computer'),
    description: translate(
      'localCommands.settings.searchDescription',
      'Let agents in cloud workspaces ask to run commands on this computer, with your approval.'
    ),
    keywords: [
      ...translateSearchKeyword('localCommands.settings.keywordLocal', 'local command'),
      ...translateSearchKeyword('localCommands.settings.keywordApprove', 'approve'),
      ...translateSearchKeyword('settings.orcaCloud.mcp.keywordCloud', 'cloud')
    ]
  }
])

export const getOrcaCloudSkillsSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('cloudAgentConfig.title', 'Skills, agents & memory'),
    description: translate(
      'settings.orcaCloud.agentConfig.searchDescription',
      'Sync Claude and Codex skills, slash commands, subagents, output styles and memory from this computer to your cloud workspaces.'
    ),
    keywords: [
      ...translateSearchKeyword('settings.orcaCloud.skills.keywordSkills', 'skills'),
      ...translateSearchKeyword('settings.orcaCloud.skills.keywordCommands', 'slash commands'),
      ...translateSearchKeyword('settings.orcaCloud.skills.keywordPrompts', 'prompts'),
      ...translateSearchKeyword('settings.orcaCloud.agentConfig.keywordSubagents', 'subagents'),
      ...translateSearchKeyword('settings.orcaCloud.agentConfig.keywordMemory', 'memory'),
      ...translateSearchKeyword(
        'settings.orcaCloud.agentConfig.keywordOutputStyles',
        'output styles'
      ),
      ...translateSearchKeyword('settings.orcaCloud.mcp.keywordSync', 'sync'),
      ...translateSearchKeyword('settings.orcaCloud.mcp.keywordCloud', 'cloud')
    ]
  }
])
