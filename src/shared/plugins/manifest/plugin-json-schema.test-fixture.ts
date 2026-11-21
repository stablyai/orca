import Ajv2020 from 'ajv/dist/2020'
import { PLUGIN_MANIFEST_V2_SINCE } from './plugin-schema-field-docs'
import type { PluginJsonSchema } from './plugin-json-schema'
import { isPluginJsonObject } from './plugin-json-object'

export function compilePluginJsonSchema(schema: PluginJsonSchema) {
  // Why no format plugin: every format the schemas use also carries a `pattern`.
  const ajv = new Ajv2020({ allErrors: true, validateFormats: false })
  ajv.addKeyword('x-orca-since')
  ajv.addKeyword('x-orca-enum-since')
  return { ajv, validate: ajv.compile(schema) }
}

/** Description of the field or fragment a pointer such as `/$defs/CatalogEntry/properties/id`
 *  names. */
export function descriptionAt(schema: PluginJsonSchema, pointer: string): string | undefined {
  let node: unknown = schema
  for (const segment of [...pointer.split('/').slice(1), 'description']) {
    node = isPluginJsonObject(node) ? node[segment] : undefined
  }
  return typeof node === 'string' ? node : undefined
}

export function v2ManifestFixture(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    manifestVersion: 2,
    execution: 'data',
    id: 'demo',
    publisher: 'acme',
    name: 'Demo',
    version: '1.0.0',
    engines: { orca: `>=${PLUGIN_MANIFEST_V2_SINCE}` },
    ...overrides
  }
}

export function catalogEntryFixture(
  overrides: Record<string, unknown> = {},
  release: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'acme.gleam-syntax',
    source: { kind: 'git', url: 'https://github.com/acme/gleam.git', ref: 'main' },
    categories: ['syntax'],
    releases: [
      {
        version: '1.0.0',
        commit: 'a'.repeat(40),
        contentHash: 'b'.repeat(64),
        execution: 'data',
        minimumOrca: PLUGIN_MANIFEST_V2_SINCE,
        types: ['syntax'],
        ...release
      }
    ],
    ...overrides
  }
}

export function catalogFixture(plugins: unknown[]): {
  catalogVersion: number
  name: string
  owner: string
  plugins: unknown[]
} {
  return { catalogVersion: 2, name: 'Acme Plugins', owner: 'acme', plugins }
}
