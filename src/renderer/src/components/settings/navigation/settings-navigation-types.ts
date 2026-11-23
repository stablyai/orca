import type { ComponentType } from 'react'
import type { LucideProps } from 'lucide-react'
import type { SettingsSearchEntry } from '@/components/settings/search/settings-search'
import {
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { Bot } from '../../../../../shared/bot-types'

export type SettingsNavIcon = ComponentType<LucideProps>
export type SettingsNavInstallStatus =
  | 'install'
  | 'installed'
  | 'up-to-date'
  | 'update-available'
  | 'needs-attention'
  | 'checking'

const SETTINGS_NAV_TARGETS = [
  'general',
  'workspace-cleanup',
  'integrations',
  'accounts',
  'browser',
  'git',
  'tasks',
  'appearance',
  'chat',
  'input',
  'floating-workspace',
  'terminal',
  'quick-commands',
  'notifications',
  'computer-use',
  'developer-permissions',
  'privacy',
  'advanced',
  'dev',
  'voice',
  'shortcuts',
  'stats',
  'ssh',
  'experimental',
  'plugins',
  'agents',
  'orchestration',
  'artifacts',
  'session-history',
  'share-skills',
  'shared-links',
  'automations',
  'bots',
  'orca-account',
  'linear',
  'setup-guide',
  'servers',
  'mobile',
  'mobile-emulator',
  'repo'
] as const

const SETTINGS_NAV_INTENTS = [
  'add-quick-command',
  'add-remote-orca-server',
  'add-ssh-host',
  'native-accounts',
  // Closes Settings when the target pane is already showing.
  'toggle'
] as const

const SETTINGS_NAV_TARGET_SET: ReadonlySet<string> = new Set(SETTINGS_NAV_TARGETS)
const SETTINGS_NAV_INTENT_SET: ReadonlySet<string> = new Set(SETTINGS_NAV_INTENTS)

export type SettingsNavTarget = (typeof SETTINGS_NAV_TARGETS)[number]
export const FULL_DISK_ACCESS_SETTINGS_TARGET_ID = 'developer-permissions-full-disk-access'
export const BROWSER_OPEN_LINKS_SETTINGS_TARGET_ID = 'browser-open-links'
export const BROWSER_TERMINAL_LINK_ACTIONS_SETTINGS_TARGET_ID = 'browser-terminal-link-actions'
export const BROWSER_CLIENT_HOSTED_REMOTE_SETTINGS_TARGET_ID = 'browser-client-hosted-remote'
export const BROWSER_SSH_WORKSPACE_ROUTING_SETTINGS_TARGET_ID = 'browser-ssh-workspace-routing'
export const BROWSER_USER_AGENT_SETTINGS_TARGET_ID = 'browser-user-agent'
export const CODEX_TERMINAL_SERVER_ISOLATION_SETTINGS_TARGET_ID =
  'agents-codex-terminal-server-isolation'
export const GLOBAL_WORKTREE_VISIBILITY_SETTINGS_TARGET_ID = 'general-global-worktree-visibility'
export const NODE_DIST_MIRROR_SETTINGS_TARGET_ID = 'advanced-node-dist-mirror'

export type SettingsNavigationTarget = {
  pane: SettingsNavTarget
  repoId: string | null
  hostId?: ExecutionHostId
  /** Host to select in the page-level Host picker; the project-host `hostId` does not move it. */
  hostScope?: RuntimeClientTarget
  /** With pane `bots`, the bot whose page opens. */
  sectionId?: string
  intent?: (typeof SETTINGS_NAV_INTENTS)[number]
  /** Move keyboard focus to the subsection's first control once it is revealed. */
  focusFirstControl?: boolean
}

function isRuntimeClientTarget(value: unknown): value is RuntimeClientTarget {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    return false
  }
  return (
    value.kind === 'local' ||
    (value.kind === 'environment' &&
      'environmentId' in value &&
      typeof value.environmentId === 'string')
  )
}

export function isSettingsNavigationTarget(value: unknown): value is SettingsNavigationTarget {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const target = value as Record<string, unknown>
  return (
    typeof target.pane === 'string' &&
    SETTINGS_NAV_TARGET_SET.has(target.pane) &&
    (typeof target.repoId === 'string' || target.repoId === null) &&
    (target.hostId === undefined ||
      (typeof target.hostId === 'string' && parseExecutionHostId(target.hostId) !== null)) &&
    (target.hostScope === undefined || isRuntimeClientTarget(target.hostScope)) &&
    (target.sectionId === undefined || typeof target.sectionId === 'string') &&
    (target.intent === undefined ||
      (typeof target.intent === 'string' && SETTINGS_NAV_INTENT_SET.has(target.intent))) &&
    (target.focusFirstControl === undefined || typeof target.focusFirstControl === 'boolean')
  )
}

export type SettingsNavSection = {
  id: string
  title: string
  description: string
  icon: SettingsNavIcon
  searchEntries: SettingsSearchEntry[]
  group: string
  badge?: string
  installStatus?: SettingsNavInstallStatus
  /** A bot's page: its nav row shows the bot's avatar in place of the icon. */
  bot?: Pick<Bot, 'id' | 'name' | 'avatar' | 'hostId'>
}

export type SettingsNavGroup = {
  id: string
  title: string
  sections: SettingsNavSection[]
}
