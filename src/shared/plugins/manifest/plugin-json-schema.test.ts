import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  catalogEntryFixture,
  catalogFixture,
  compilePluginJsonSchema as compile
} from './plugin-json-schema.test-fixture'
import {
  pluginCatalogJsonSchema,
  pluginManifestJsonSchema,
  pluginSchemaGeneratedFiles,
  type PluginJsonSchema
} from './plugin-json-schema'
import { parsePluginManifest, pluginManifestV2Object } from './plugin-manifest'
import { pluginCatalogDocumentSchema, pluginCatalogSchema } from '../catalog/plugin-catalog'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')

/** Every property in the schema with its JSON pointer, including fragments and nested objects. */
function properties(schema: PluginJsonSchema, pointer = ''): [string, PluginJsonSchema][] {
  const own = Object.entries(schema.properties ?? {}).flatMap(([key, node]) => {
    const field = typeof node === 'object' ? node : {}
    const at = `${pointer}/properties/${key}`
    const entry: [string, PluginJsonSchema] = [at, field]
    return [entry, ...properties(field, at)]
  })
  const defs = Object.entries(schema.$defs ?? {}).flatMap(([name, def]) =>
    properties(def, `${pointer}/$defs/${name}`)
  )
  return [...own, ...defs]
}

function manifestFixtures(): { file: string; raw: unknown }[] {
  return ['examples/plugins', 'resources/plugins/launch'].flatMap((dir) =>
    readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name, 'orca-plugin.json'))
      .map((file) => ({ file, raw: JSON.parse(readFileSync(path.join(REPO_ROOT, file), 'utf8')) }))
  )
}

type ZodField = [path: string, field: z.core.$ZodType]

/** Unwraps optional/default/catch/pipe layers to the object or array that holds child fields. */
function container(schema: z.core.$ZodType): z.core.$ZodType {
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodPrefault ||
    schema instanceof z.ZodCatch
  ) {
    return container(schema.def.innerType)
  }
  return schema instanceof z.ZodPipe ? container(schema.def.in) : schema
}

/** Every object field under `schema` with its dotted path, as declared (so it carries its meta). */
function zodFields(schema: z.core.$ZodType, at = ''): ZodField[] {
  const inner = container(schema)
  if (inner instanceof z.ZodArray) {
    return zodFields(inner.def.element, `${at}[]`)
  }
  if (!(inner instanceof z.ZodObject)) {
    return []
  }
  return Object.entries(inner.def.shape).flatMap(([key, field]) => [
    [`${at}.${key}`, field] satisfies ZodField,
    ...zodFields(field, `${at}.${key}`)
  ])
}

/** A catch layer accepts anything; examples must satisfy the shape it guards. */
function strict(schema: z.core.$ZodType): z.core.$ZodType {
  return schema instanceof z.ZodCatch ? strict(schema.def.innerType) : schema
}

function examplesOf(field: z.core.$ZodType): unknown[] {
  const examples: unknown = z.globalRegistry.get(field)?.examples
  return Array.isArray(examples) ? examples : []
}

describe('published plugin schemas', () => {
  it('match the committed files (run `pnpm generate:plugin-schemas` when this fails)', () => {
    for (const [file, content] of Object.entries(pluginSchemaGeneratedFiles())) {
      const committed = readFileSync(path.join(REPO_ROOT, file), 'utf8')
      expect(committed, `${file} is stale: run pnpm generate:plugin-schemas`).toBe(content)
    }
  })

  it.each([
    ['manifest', pluginManifestJsonSchema()],
    ['catalog', pluginCatalogJsonSchema()]
  ])('documents every %s field with a description and a since-version', (_name, schema) => {
    // Why skip $ref fields: they point at a fragment, which is checked below.
    for (const [pointer, field] of properties(schema).filter(([, field]) => !field.$ref)) {
      expect(field.description, pointer).toBeTruthy()
      expect(field['x-orca-since'], pointer).toBeTruthy()
    }
    for (const [name, def] of Object.entries(schema.$defs ?? {})) {
      expect(def.description, name).toBeTruthy()
    }
  })

  it.each([
    ['manifest', pluginManifestJsonSchema()],
    ['catalog', pluginCatalogJsonSchema()]
  ])('accepts every documented %s example', (_name, schema) => {
    const { ajv } = compile(schema)
    for (const [pointer, field] of properties(schema)) {
      for (const example of field.examples ?? []) {
        const validate = ajv.getSchema(`${schema.$id}#${pointer}`)
        expect(validate?.(example), `${pointer}: ${JSON.stringify(example)}`).toBe(true)
      }
    }
  })

  it.each([
    ['manifest', pluginManifestV2Object],
    ['catalog', pluginCatalogDocumentSchema]
  ])('accepts every documented %s example at runtime too', (_name, root) => {
    const fields = zodFields(root)
    expect(fields.length).toBeGreaterThan(10)
    const examples = fields.flatMap(([at, field]) =>
      examplesOf(field).map((example) => ({ at, field, example }))
    )
    expect(examples.length).toBeGreaterThan(5)
    for (const { at, field, example } of examples) {
      expect(z.safeParse(strict(field), example).success, `${at}: ${JSON.stringify(example)}`).toBe(
        true
      )
    }
  })

  it('agrees with the runtime on every bundled and example v2 manifest', () => {
    const { validate } = compile(pluginManifestJsonSchema())
    const v2 = manifestFixtures().filter(({ raw }) =>
      JSON.stringify(raw).includes('"manifestVersion":2')
    )
    expect(v2.length).toBeGreaterThan(0)
    for (const { file, raw } of v2) {
      expect(validate(raw), `${file}: ${JSON.stringify(validate.errors)}`).toBe(true)
      expect(parsePluginManifest(raw), file).toMatchObject({ ok: true })
    }
  })

  it('accepts a release-bearing catalog Orca accepts', () => {
    const { validate } = compile(pluginCatalogJsonSchema())
    const catalog = {
      $schema: pluginCatalogJsonSchema().$id,
      ...catalogFixture([
        catalogEntryFixture(
          {},
          {
            name: 'Gleam',
            fileTypes: ['gleam'],
            license: 'Apache-2.0',
            repository: 'https://github.com/acme/gleam',
            homepage: 'https://gleam.example.com',
            updatedAt: '2026-10-20T09:30:00Z',
            changelog: 'Highlights use expressions.'
          }
        )
      ])
    }
    expect(validate(catalog), JSON.stringify(validate.errors)).toBe(true)
    expect(pluginCatalogSchema.parse(catalog).plugins).toHaveLength(1)
  })
})
