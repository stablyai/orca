import { PLUGIN_CATALOG_FILENAME, PLUGIN_CATALOG_VERSION } from '../catalog/plugin-catalog'
import { PLUGIN_MARKETPLACE_FILENAME } from '../catalog/plugin-marketplace'
import { PLUGIN_SCHEMA_SINCE_V1 } from './plugin-schema-field-docs'
import {
  PLUGIN_PLANNED_CONTRIBUTION_POINTS,
  PLUGIN_RESERVED_CONTRIBUTION_POINTS
} from '../plugin-contribution-points'

const reservedKeys = Object.keys(PLUGIN_RESERVED_CONTRIBUTION_POINTS).map((key, index) =>
  index === 0 ? `\`contributes.${key}\`` : `\`${key}\``
)

/** Compatibility policy appended to the manifest reference. Prose lives beside the schemas it
 *  explains so the generated pages and the code change together. */
export const PLUGIN_MANIFEST_POLICY_NOTES: readonly string[] = [
  '## Versions and compatibility',
  '',
  '- **What runs is strict.** Orca refuses a manifest with any key it does not know, at every level, so an older Orca never silently ignores something a plugin relies on.',
  '- **`engines.orca` is the only version gate.** It must be at least the newest `Since` of every field and every value (capability, event, built-in action) the manifest uses. Orca checks this when it validates, lists or installs a plugin, so an older Orca can always say "requires Orca >=X (this is Y)" instead of listing unknown fields.',
  '- **`pluginApi` is optional.** It names the major version of the host API ([reference](plugin-host-api.md)), which only grows within major 1; Orca refuses a major it does not implement. Only `sandboxed-ui` and `trusted-worker` plugins call that API, so `data` and `declarative` plugins must leave it out.',
  '- **New fields, contribution points and values are additive.** They arrive with a `Since` version; nothing else changes. `manifestVersion` rises only if an existing field changes meaning.',
  '- **Deprecation.** A field to be removed is marked deprecated here and keeps working for at least one release; it is removed only together with a higher `engines.orca` requirement, and its name is never reused.',
  `- **Reserved contribution points.** ${reservedKeys.slice(0, -1).join(', ')} and ${reservedKeys.at(-1)} are held for planned features and must stay empty until their format is defined. Each will arrive as an additive point with its own \`Since\`, without a new manifest format.`,
  '',
  '## Planned contribution points',
  '',
  'Each reserved point is planned as declared data that Orca renders and enforces, never arbitrary plugin UI. The intended shapes, which may still change:',
  '',
  ...Object.entries(PLUGIN_PLANNED_CONTRIBUTION_POINTS).map(
    ([key, plan]) => `- \`${key}\`: ${plan}`
  ),
  '',
  '## Legacy format 1',
  '',
  `Orca still loads \`"manifestVersion": 1\` manifests (read since ${PLUGIN_SCHEMA_SINCE_V1}), but new plugins should use format 2. Format 1 differs in three ways:`,
  '',
  '- It has no `execution` field. Orca derives the least profile that can run what the manifest declares.',
  '- Unknown top-level keys are ignored instead of rejected.',
  '- The published JSON Schema does not describe it, so editors offer no completion for it.'
]

/** Compatibility policy appended to the catalog reference. */
export const PLUGIN_CATALOG_POLICY_NOTES: readonly string[] = [
  '## Versions and compatibility',
  '',
  `- **What only lists is tolerant.** A catalog never decides what runs (installing re-checks the exact bytes), so Orca keeps whatever it can read: unknown keys are ignored at every level, an entry it cannot read is skipped, an invalid display-only field is dropped, a list over its limit is trimmed, and a repeated \`id\` keeps the first entry. Validation in CI is where these become errors.`,
  `- **The file name never changes.** \`catalogVersion\` (now ${PLUGIN_CATALOG_VERSION}) rises only for a change older clients cannot ignore; an Orca that sees a higher number refuses the catalog with "update Orca to browse this catalog" rather than misreading it.`,
  '- **Releases are a list, newest first.** Orca offers the first release whose `minimumOrca` it meets, so keep the previous release listed when a new one raises `engines.orca`; Orca shows "Needs Orca X" only when none fits.',
  '',
  '## Clients before format 2',
  '',
  `Orca reads \`${PLUGIN_CATALOG_FILENAME}\` first and falls back to \`${PLUGIN_MARKETPLACE_FILENAME}\`. That older file is frozen: shipped clients reject any key they do not know, so it carries only \`name\`, \`owner\` and each plugin's \`id\`, \`source\`, \`description\` and \`categories\`. Generate it from \`${PLUGIN_CATALOG_FILENAME}\` rather than editing two files:`,
  '',
  '```sh',
  `node config/scripts/export-legacy-plugin-catalog.mjs ${PLUGIN_CATALOG_FILENAME} ${PLUGIN_MARKETPLACE_FILENAME}`,
  '```'
]
