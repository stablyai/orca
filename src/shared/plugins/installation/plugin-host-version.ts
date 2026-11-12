import { satisfiesOrcaEngineRange } from '../manifest/plugin-manifest-engine-range'
import {
  PLUGIN_COMPONENTS_CATALOG_2_SINCE,
  PLUGIN_COMPONENTS_CATALOG_4_SINCE,
  PLUGIN_DERIVED_PUBLISHER_SINCE,
  PLUGIN_EDITOR_FRAME_SINCE,
  PLUGIN_HOOKS_SINCE,
  PLUGIN_HOST_ACTIONS_SINCE,
  PLUGIN_MANIFEST_V2_SINCE,
  PLUGIN_PANEL_UI_SINCE,
  PLUGIN_SCHEMA_SINCE_V1,
  PLUGIN_THEME_VIDEO_BACKGROUND_SINCE
} from '../manifest/plugin-schema-field-docs'
import { PLUGIN_STATUS_BAR_SINCE } from '../contributions/plugin-status-bar-item-contribution'
import { PLUGIN_COMMAND_REPLACES_SINCE } from '../contributions/plugin-command-contribution'
import { PLUGIN_APPEARANCE_SINCE } from '../workers/plugin-host-api-appearance'
import { PLUGIN_FONTS_SINCE } from '../contributions/plugin-font-contribution'
import { PLUGIN_WORKTREE_BADGES_SINCE } from '../contributions/plugin-worktree-badge-contribution'
import { PLUGIN_EDITOR_TYPOGRAPHY_SINCE } from '../workers/plugin-host-api-editor-typography'
import { PLUGIN_HOST_API_1_7_SINCE } from '../workers/plugin-host-api-workspace-methods'
import { PLUGIN_HOST_API_1_8_SINCE } from '../workers/plugin-host-api-1-8'
import { PLUGIN_HOST_API_1_9_SINCE } from '../workers/plugin-host-api-1-9'

/** The newest "since" this build's schemas cite: everything up to it is readable here. */
export const PLUGIN_SCHEMA_NEWEST_SINCE = [
  PLUGIN_SCHEMA_SINCE_V1,
  PLUGIN_MANIFEST_V2_SINCE,
  PLUGIN_DERIVED_PUBLISHER_SINCE,
  PLUGIN_HOST_ACTIONS_SINCE,
  PLUGIN_PANEL_UI_SINCE,
  PLUGIN_COMPONENTS_CATALOG_2_SINCE,
  PLUGIN_COMPONENTS_CATALOG_4_SINCE,
  PLUGIN_EDITOR_FRAME_SINCE,
  PLUGIN_STATUS_BAR_SINCE,
  PLUGIN_HOOKS_SINCE,
  PLUGIN_HOST_ACTIONS_SINCE,
  PLUGIN_COMMAND_REPLACES_SINCE,
  PLUGIN_APPEARANCE_SINCE,
  PLUGIN_FONTS_SINCE,
  PLUGIN_WORKTREE_BADGES_SINCE,
  PLUGIN_THEME_VIDEO_BACKGROUND_SINCE,
  PLUGIN_EDITOR_TYPOGRAPHY_SINCE,
  PLUGIN_HOST_API_1_7_SINCE,
  PLUGIN_HOST_API_1_8_SINCE,
  PLUGIN_HOST_API_1_9_SINCE
].reduce((newest, version) => (satisfiesOrcaEngineRange(version, `>=${newest}`) ? version : newest))

/**
 * The version plugins are gated against. Why not the app version alone: development and local
 * builds keep the package version of the last version bump while already reading every field
 * their schemas define, so a plugin correctly declaring `>=<newest since>` would be refused by
 * the build that introduced the field. Releases are at or past that version, so this changes
 * nothing for them.
 */
export function pluginHostVersion(appVersion: string): string {
  return satisfiesOrcaEngineRange(appVersion, `>=${PLUGIN_SCHEMA_NEWEST_SINCE}`)
    ? appVersion
    : PLUGIN_SCHEMA_NEWEST_SINCE
}
