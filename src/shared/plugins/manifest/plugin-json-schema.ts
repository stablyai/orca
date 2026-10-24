import { z } from 'zod'
import { pluginManifestV2Object } from './plugin-manifest'
import { PLUGIN_CATALOG_FILENAME, pluginCatalogDocumentSchema } from '../catalog/plugin-catalog'
import { renderPluginSchemaReference } from './plugin-schema-reference-doc'
import {
  PLUGIN_CATALOG_POLICY_NOTES,
  PLUGIN_MANIFEST_POLICY_NOTES
} from './plugin-schema-policy-notes'

// Why the format in the file name: a later breaking format publishes beside v2, so a URL an author
// pinned never changes meaning under them.
export const PLUGIN_SCHEMA_DIRECTORY = 'docs/schemas/plugins'
export const PLUGIN_MANIFEST_SCHEMA_FILE = 'orca-plugin.v2.schema.json'
export const PLUGIN_CATALOG_SCHEMA_FILE = 'orca-catalog.v2.schema.json'
/** Git ref the published `$id` points at. Why `main` for now: no release ships v2 yet; switch to
 *  the release tag that does, so editors only offer fields a shipped Orca reads. A test enforces
 *  the switch once that tag exists. */
export const PLUGIN_SCHEMA_GIT_REF = 'main'
export const PLUGIN_SCHEMA_BASE_URL = `https://raw.githubusercontent.com/stablyai/orca/${PLUGIN_SCHEMA_GIT_REF}/${PLUGIN_SCHEMA_DIRECTORY}/`
/** The starter plugin authors copy; it carries the schema so completion works offline. */
const PLUGIN_TEMPLATE_DIRECTORY = 'examples/plugins/orca-gleam-syntax'

export type PluginJsonSchema = z.core.JSONSchema.BaseSchema

function toPublishedSchema(
  schema: z.ZodType,
  file: string,
  title: string,
  description: string
): PluginJsonSchema {
  // Why input side: authors write what Orca reads, before defaults and transforms apply.
  const generated = z.toJSONSchema(schema, {
    io: 'input',
    target: 'draft-2020-12',
    unrepresentable: 'any'
  })
  const { $schema, ...body } = generated
  return { $schema, $id: `${PLUGIN_SCHEMA_BASE_URL}${file}`, title, description, ...body }
}

export function pluginManifestJsonSchema(): PluginJsonSchema {
  return toPublishedSchema(
    pluginManifestV2Object,
    PLUGIN_MANIFEST_SCHEMA_FILE,
    'Orca plugin manifest',
    'The orca-plugin.json file at the root of an Orca plugin (manifest format 2).'
  )
}

export function pluginCatalogJsonSchema(): PluginJsonSchema {
  return toPublishedSchema(
    pluginCatalogDocumentSchema,
    PLUGIN_CATALOG_SCHEMA_FILE,
    'Orca plugin catalog',
    `The ${PLUGIN_CATALOG_FILENAME} file that lists installable plugins and their releases.`
  )
}

/** Every generated file, keyed by repo-relative path. One list keeps the writer and the drift
 *  test from disagreeing about what is generated. */
export function pluginSchemaGeneratedFiles(): Record<string, string> {
  const manifest = pluginManifestJsonSchema()
  const catalog = pluginCatalogJsonSchema()
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`
  return {
    [`${PLUGIN_SCHEMA_DIRECTORY}/${PLUGIN_MANIFEST_SCHEMA_FILE}`]: manifestJson,
    [`${PLUGIN_TEMPLATE_DIRECTORY}/${PLUGIN_MANIFEST_SCHEMA_FILE}`]: manifestJson,
    [`${PLUGIN_SCHEMA_DIRECTORY}/${PLUGIN_CATALOG_SCHEMA_FILE}`]: `${JSON.stringify(catalog, null, 2)}\n`,
    'docs/reference/plugin-manifest.md': renderPluginSchemaReference(manifest, {
      file: 'orca-plugin.json',
      schemaFile: PLUGIN_MANIFEST_SCHEMA_FILE,
      sinceNote:
        '`Since` is the first Orca release that reads the field; raise `engines.orca` when you use a newer one.',
      appendix: PLUGIN_MANIFEST_POLICY_NOTES
    }),
    'docs/reference/plugin-catalog.md': renderPluginSchemaReference(catalog, {
      file: PLUGIN_CATALOG_FILENAME,
      schemaFile: PLUGIN_CATALOG_SCHEMA_FILE,
      sinceNote:
        '`Since` is the first Orca release that reads the field. Older releases ignore fields they do not know.',
      appendix: PLUGIN_CATALOG_POLICY_NOTES
    })
  }
}
