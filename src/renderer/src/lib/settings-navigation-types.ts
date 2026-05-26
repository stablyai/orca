import type { LucideIcon } from 'lucide-react'
import type { SettingsSearchEntry } from '@/components/settings/settings-search'

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
  icon: LucideIcon
  searchEntries: SettingsSearchEntry[]
  group: string
  badge?: string
}

export type SettingsNavGroup = {
  id: string
  title: string
  sections: SettingsNavSection[]
}
