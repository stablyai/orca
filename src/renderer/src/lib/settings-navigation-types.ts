import type { ComponentType } from 'react'
import type { LucideProps } from 'lucide-react'
import type { SettingsSearchEntry } from '@/components/settings/settings-search'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'

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
  'integrations',
  'accounts',
  'browser',
  'git',
  'tasks',
  'appearance',
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
  'automations',
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
  'add-ssh-host'
] as const

const SETTINGS_NAV_TARGET_SET: ReadonlySet<string> = new Set(SETTINGS_NAV_TARGETS)
const SETTINGS_NAV_INTENT_SET: ReadonlySet<string> = new Set(SETTINGS_NAV_INTENTS)

export type SettingsNavTarget = (typeof SETTINGS_NAV_TARGETS)[number]
export const FULL_DISK_ACCESS_SETTINGS_TARGET_ID = 'developer-permissions-full-disk-access'
export const BROWSER_TERMINAL_LINK_ACTIONS_SETTINGS_TARGET_ID = 'browser-terminal-link-actions'

export type SettingsNavigationTarget = {
  pane: SettingsNavTarget
  repoId: string | null
  hostId?: ExecutionHostId
  sectionId?: string
  intent?: (typeof SETTINGS_NAV_INTENTS)[number]
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
    (target.sectionId === undefined || typeof target.sectionId === 'string') &&
    (target.intent === undefined ||
      (typeof target.intent === 'string' && SETTINGS_NAV_INTENT_SET.has(target.intent)))
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
}

export type SettingsNavGroup = {
  id: string
  title: string
  sections: SettingsNavSection[]
}
