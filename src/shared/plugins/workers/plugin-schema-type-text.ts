import { z } from 'zod'

type JsonSchema = z.core.JSONSchema.BaseSchema

/** How the printer names types JSON Schema cannot spell: any JSON value, and `{}` with no keys. */
export type SchemaTypeTextOptions = { json: string; emptyObject: string }

/** Reads as a signature in Markdown references. */
export const REFERENCE_TYPE_TEXT: SchemaTypeTextOptions = { json: 'JSON', emptyObject: '{}' }

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

function asSchema(node: z.core.JSONSchema._JSONSchema | undefined): JsonSchema {
  return typeof node === 'object' ? node : {}
}

/** TypeScript type text for a JSON Schema node, so a schema reads as a type rather than a dump. */
export function schemaTypeText(schema: JsonSchema, options: SchemaTypeTextOptions): string {
  const text = (node: z.core.JSONSchema._JSONSchema | undefined): string =>
    schemaTypeText(asSchema(node), options)
  if (schema.const !== undefined) {
    return JSON.stringify(schema.const)
  }
  if (schema.enum) {
    return schema.enum.map((value) => JSON.stringify(value)).join(' | ')
  }
  if (schema.anyOf) {
    return schema.anyOf.map(text).join(' | ')
  }
  if (schema.type === 'array') {
    const item = text(Array.isArray(schema.items) ? undefined : schema.items)
    return item.includes(' ') && !item.startsWith('{') ? `(${item})[]` : `${item}[]`
  }
  if (schema.type === 'object' && schema.properties) {
    const required = new Set(schema.required ?? [])
    const fields = Object.entries(schema.properties).map(
      ([key, node]) =>
        `${IDENTIFIER.test(key) ? key : JSON.stringify(key)}${required.has(key) ? '' : '?'}: ${text(node)}`
    )
    return fields.length === 0 ? options.emptyObject : `{ ${fields.join('; ')} }`
  }
  if (schema.type === 'object' && typeof schema.additionalProperties === 'object') {
    return `Record<string, ${text(schema.additionalProperties)}>`
  }
  if (schema.type === 'integer') {
    return 'number'
  }
  if (Array.isArray(schema.type)) {
    return schema.type.join(' | ')
  }
  return schema.type ?? options.json
}

/** Type text of what a caller passes (`input`) or receives (`output`) for a Zod schema. */
export function zodTypeText(
  schema: z.ZodType,
  io: 'input' | 'output',
  options: SchemaTypeTextOptions
): string {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any', io })
  return schemaTypeText(json, options)
}
