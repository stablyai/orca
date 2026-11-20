import { WORKSPACE_APP_CHANNELS } from './workspace-app-channels'
import { INTEGRATIONS_APP_CHANNELS } from './integrations-app-channels'
import { CORE_APP_CHANNELS } from './core-app-channels'
import { SERVICES_APP_CHANNELS } from './services-app-channels'

export const APP_CHANNELS = [
  ...WORKSPACE_APP_CHANNELS,
  ...INTEGRATIONS_APP_CHANNELS,
  ...CORE_APP_CHANNELS,
  ...SERVICES_APP_CHANNELS
] as const

export type AppChannel = (typeof APP_CHANNELS)[number]
