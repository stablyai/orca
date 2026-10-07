import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  liftAgentBypassFromTypedProfile,
  liftComposedAgentLaunchProfile
} from '../../../../shared/agent-launch-profile-lift'
import { resolveLocalAgentLaunchTarget } from '../../../../shared/windows-terminal-shell'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'

/**
 * The web client's stored agent launch profile in its typed shape. Blobs saved before the mode was
 * typed carry the flag in each agent's args, and an older build can write it back into a typed blob.
 */
export function migrateStoredWebAgentLaunch(stored: Partial<GlobalSettings>): {
  profile: Partial<GlobalSettings>
  changed: boolean
} {
  if (stored.agentPermissionMode !== undefined) {
    return liftAgentBypassFromTypedProfile(stored)
  }
  if (stored.agentDefaultArgs === undefined && stored.agentDefaultEnv === undefined) {
    return { profile: {}, changed: false }
  }
  const profile = liftComposedAgentLaunchProfile(
    stored,
    resolveLocalAgentLaunchTarget(getRendererAppPlatform(), stored.terminalWindowsShell)
  )
  return { profile, changed: profile.agentPermissionMode !== stored.agentPermissionMode }
}
