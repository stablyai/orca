import type { ComponentType } from 'react'
import type { LucideProps } from 'lucide-react'
import type { SettingsSearchEntry } from '@/components/settings/settings-search'

export type SettingsNavIcon = ComponentType<LucideProps>
export type SettingsNavInstallStatus = 'install' | 'installed' | 'checking'

export type SettingsNavTarget =
  | 'general'
  | 'integrations'
  | 'accounts'
  | 'browser'
  | 'git'
  | 'tasks'
  | 'appearance'
  | 'input'
  | 'floating-workspace'
  | 'terminal'
  | 'quick-commands'
  | 'notifications'
  | 'computer-use'
  | 'developer-permissions'
  | 'privacy'
  | 'advanced'
  | 'voice'
  | 'shortcuts'
  | 'stats'
  | 'ssh'
  | 'experimental'
  | 'agents'
  | 'orchestration'
  | 'servers'
  | 'mobile'
  | 'repo'

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
