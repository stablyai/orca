import {
  DROID_MACOS_ORG_SETTINGS_PATH,
  DROID_POSIX_ORG_SETTINGS_PATH
} from '../../droid/droid-org-settings-path'

/** Read-only organization policy files outside home that a guest hook installer may consult. */
export const AGENT_HOOK_POLICY_READ_PATHS: ReadonlySet<string> = new Set([
  DROID_POSIX_ORG_SETTINGS_PATH,
  DROID_MACOS_ORG_SETTINGS_PATH
])
