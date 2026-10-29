import { PLUGIN_CATALOG_FILENAME, PLUGIN_CATALOG_VERSION } from '../catalog/plugin-catalog'
import { PLUGIN_MARKETPLACE_FILENAME } from '../catalog/plugin-marketplace'
import { PLUGIN_SCHEMA_SINCE_V1 } from './plugin-schema-field-docs'
import {
  PLUGIN_PLANNED_CONTRIBUTION_POINTS,
  PLUGIN_RESERVED_CONTRIBUTION_POINTS
} from '../contributions/plugin-contribution-points'

const reservedKeys = Object.keys(PLUGIN_RESERVED_CONTRIBUTION_POINTS).map((key, index) =>
  index === 0 ? `\`contributes.${key}\`` : `\`${key}\``
)

/** Compatibility policy appended to the manifest reference. Prose lives beside the schemas it
 *  explains so the generated pages and the code change together. */
export const PLUGIN_MANIFEST_POLICY_NOTES: readonly string[] = [
  '## Versions and compatibility',
  '',
  '- **What runs is strict.** Orca refuses a manifest with any key it does not know, at every level, so an older Orca never silently ignores something a plugin relies on.',
  '- **`engines.orca` is the only version gate.** It must be at least the newest `Since` of every field and every value (capability, event, built-in action) the manifest uses. `pnpm validate:plugin` and catalog CI enforce it, so an older Orca can always say "requires Orca >=X (this is Y)" instead of listing unknown fields.',
  '- **`pluginApi` is optional.** It names the major version of the host API ([reference](plugin-host-api.md)), which only grows within major 1; Orca refuses a major it does not implement. Only `sandboxed-ui` and `trusted-worker` plugins call that API, so `data` and `declarative` plugins must leave it out.',
  '- **`terminal:send` needs `trusted-worker`.** Panels get no host method that types into a terminal, so Orca refuses the capability on any other profile instead of asking the user to grant something the plugin can never use.',
  '- **New fields, contribution points and values are additive.** They arrive with a `Since` version; nothing else changes. `manifestVersion` rises only if an existing field changes meaning.',
  '- **Deprecation.** A field to be removed is marked deprecated here and keeps working for at least one release; it is removed only together with a higher `engines.orca` requirement, and its name is never reused.',
  `- **Reserved contribution points.** ${reservedKeys.slice(0, -1).join(', ')} and ${reservedKeys.at(-1)} are held for planned features and must stay empty until their format is defined. Each will arrive as an additive point with its own \`Since\`, without a new manifest format. \`skills\`, \`mcpServers\` and \`hooks\` keep the meaning agent-plugin formats such as Claude Code's give them; \`agents\` stays unclaimed because those formats use it for subagent files.`,
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
  '## Publisher names and trust',
  '',
  '- **Publisher is the repository owner.** The official and community catalogs list a plugin only when its `publisher` equals the GitHub or GitLab user or organization that owns its repository (`acme` for `github.com/acme/gleam-syntax`). Their CI enforces this; Orca does not check it for catalogs you add yourself.',
  "- **Reserved names install only from Orca's official catalog.** The publishers `stablyai`, `official`, `anthropic`, `openai`, `github` and any starting `orca` (any case), and ids starting `orca-`, are refused from any other catalog, a Git URL or a local folder. A catalog that lists one is refused whole. `pnpm validate:plugin` rejects these publishers except `stablyai`.",
  "- **Trust comes from the catalog's address.** Orca labels a plugin with where it came from: the Official mark for Orca's catalog, otherwise the catalog's name and the owner in its Git URL (`github.com/acme`, `gitlab.com/acme/tools`), never the manifest's text. Development folders show `Dev · unverified`, Git URL installs `Unverified`.",
  '- **An install stays with its catalog.** Orca records the catalog each plugin was installed from and updates it only from there. When another catalog lists the same id, the plugin page says so, and switching means removing the plugin and installing it again.',
  '',
  '## One repository can hold many plugins',
  '',
  "Give each plugin its own directory and set `source.path` to it. Orca downloads the pinned commit but installs only that directory, and `contentHash` covers only its files, so a commit that changes a sibling plugin leaves this plugin's hash, and its users, untouched. Moving a plugin to another directory counts as moving repositories: users review the update before it installs.",
  '',
  '```json',
  '{ "id": "acme.gleam-syntax", "source": { "kind": "git", "url": "https://github.com/acme/orca-plugins.git", "ref": "main", "path": "plugins/gleam-syntax" } }',
  '```',
  '',
  "Run `pnpm validate:plugin plugins/gleam-syntax` in that repository to print the directory's `path` and its release entry. Listing images stay relative to the catalog repository.",
  '',
  '## Install links',
  '',
  "An install link opens Orca at a plugin's page in Settings → Plugins. It never installs: the user reads the page and presses Install, and the usual review applies. If plugins are off, the page waits behind **Turn on plugins**.",
  '',
  '```text',
  'orca://plugins/<publisher>.<id>?catalog=<official | community | catalog Git URL>',
  '```',
  '',
  "- `catalog` defaults to `official`. `community` is Orca's community catalog. Any other value must be an HTTPS or SSH Git URL of at most 512 characters, read at its `main` branch, without a password or token. Orca asks **Add catalog …?** before fetching a catalog the user hasn't added, and that includes `community`.",
  "- Reserved publishers (above) are accepted only with the official catalog. A link longer than 2048 characters, with another query parameter, or with an id that isn't `<publisher>.<id>` shows a short error and does nothing else. Repeats of the same link within a few seconds are ignored.",
  '- Browsers and README viewers often block custom schemes, so link to the directory page instead. It opens the `orca://` link and shows install steps when Orca is missing: `https://onorca.dev/plugins/<publisher>.<id>?catalog=<same value>`.',
  '',
  'For a README:',
  '',
  '```md',
  '[Open in Orca](https://onorca.dev/plugins/acme.gleam-syntax?catalog=community)',
  '```',
  '',
  '## Clients before format 2',
  '',
  `Orca reads \`${PLUGIN_CATALOG_FILENAME}\` first and falls back to \`${PLUGIN_MARKETPLACE_FILENAME}\`. That older file is frozen: shipped clients reject any key they do not know, so it carries only \`name\`, \`owner\` and each plugin's \`id\`, \`source\`, \`description\` and \`categories\`, and leaves out plugins with a \`source.path\`, which those clients would install from the repository root. Generate it from \`${PLUGIN_CATALOG_FILENAME}\` rather than editing two files:`,
  '',
  '```sh',
  `node config/scripts/export-legacy-plugin-catalog.mjs ${PLUGIN_CATALOG_FILENAME} ${PLUGIN_MARKETPLACE_FILENAME}`,
  '```'
]
