import type * as React from 'react'
import type {
  AgentLaunchSettings,
  AgentLaunchSettingsMutation
} from '../../../../shared/agent-launch-settings'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import type { AgentPermissionsSettingProps } from './AgentPermissionsSetting'

export type AgentPermissionsRenderer = (props: AgentPermissionsSettingProps) => React.ReactNode

export type AgentLaunchSettingsCatalogProps = {
  settings: AgentLaunchSettings
  mutate: (mutation: AgentLaunchSettingsMutation) => Promise<void>
  detectionTarget: AgentDetectionTarget
  hostName: string | null
  renderPermissions: AgentPermissionsRenderer
  refreshSettings?: () => void
  autoSupported?: boolean
  choicesSupported?: boolean
  nativeChatPermissionsSupported?: boolean
  chatOwnSupported?: boolean
  local?: {
    settings: GlobalSettings
    saveEnvironment: (agent: TuiAgent, value: Record<string, string>) => Promise<void>
    updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  }
}
