import { z } from 'zod'

const base = { title: z.string().optional(), description: z.string().optional() }
export const AgentSessionFormFieldSchema = z.union([
  z.strictObject({
    ...base,
    type: z.literal('string'),
    enum: z.array(z.string()).min(1),
    enumNames: z.array(z.string()).optional(),
    default: z.string().optional()
  }),
  z.strictObject({
    ...base,
    type: z.literal('string'),
    oneOf: z.array(z.strictObject({ const: z.string(), title: z.string() })).min(1),
    default: z.string().optional()
  }),
  z.strictObject({
    ...base,
    type: z.literal('string'),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().nonnegative().optional(),
    format: z.enum(['email', 'uri', 'date', 'date-time']).optional(),
    default: z.string().optional()
  }),
  z.strictObject({
    ...base,
    type: z.enum(['number', 'integer']),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    default: z.number().optional()
  }),
  z.strictObject({ ...base, type: z.literal('boolean'), default: z.boolean().optional() })
])
export const AgentSessionFormObjectSchema = z.strictObject({
  $schema: z.string().optional(),
  type: z.literal('object'),
  properties: z.record(z.string(), AgentSessionFormFieldSchema),
  required: z.array(z.string()).optional()
})

export const AGENT_SESSION_FORM_VALUE_MAX_BYTES = 64 * 1024
export const AgentSessionFormSchema = z.object({
  fields: z
    .array(
      z.object({
        name: z.string().min(1),
        required: z.boolean(),
        schema: AgentSessionFormFieldSchema
      })
    )
    .max(64)
})
export type AgentSessionForm = z.infer<typeof AgentSessionFormSchema>
export type AgentSessionFormField = AgentSessionForm['fields'][number]
export const AgentSessionFormContentSchema = z
  .record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()]))
  .superRefine((content, ctx) => {
    if (
      Object.keys(content).length > 64 ||
      Object.values(content).some(
        (value) =>
          new TextEncoder().encode(JSON.stringify(value)).byteLength >
          AGENT_SESSION_FORM_VALUE_MAX_BYTES
      )
    ) {
      ctx.addIssue({ code: 'custom', message: 'Form values exceed the supported size.' })
    }
  })
export type AgentSessionFormContent = z.infer<typeof AgentSessionFormContentSchema>
export type AgentSessionFormDraft = ReadonlyMap<string, string | boolean>

export function agentSessionFormChoices(
  field: AgentSessionFormField
): { label: string; value: string | boolean }[] {
  const schema = field.schema
  if ('enum' in schema) {
    return schema.enum.map((value, index) => ({ label: schema.enumNames?.[index] ?? value, value }))
  }
  if ('oneOf' in schema) {
    return schema.oneOf.map((option) => ({ label: option.title, value: option.const }))
  }
  return schema.type === 'boolean'
    ? [
        { label: 'Yes', value: true },
        { label: 'No', value: false }
      ]
    : []
}

export function validateAgentSessionFormField(field: AgentSessionFormField, value: unknown): void {
  const schema = field.schema
  const choices = agentSessionFormChoices(field)
  if (choices.length > 0) {
    if (!choices.some((choice) => choice.value === value)) {
      throw new Error('Choose an offered value.')
    }
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') {
      throw new Error('Enter text.')
    }
    const length = [...value].length
    if ('minLength' in schema && schema.minLength !== undefined && length < schema.minLength) {
      throw new Error(`Enter at least ${schema.minLength} characters.`)
    }
    if ('maxLength' in schema && schema.maxLength !== undefined && length > schema.maxLength) {
      throw new Error(`Enter at most ${schema.maxLength} characters.`)
    }
    if ('format' in schema && schema.format) {
      const formats = {
        email: z.email(),
        uri: z.url(),
        date: z.iso.date(),
        'date-time': z.iso.datetime({ offset: true })
      }
      if (!formats[schema.format].safeParse(value).success) {
        throw new Error(`Enter a valid ${schema.format} value.`)
      }
    }
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('Enter a finite number.')
    }
    if (schema.type === 'integer' && !Number.isSafeInteger(value)) {
      throw new Error('Enter a whole number within the supported range.')
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      throw new Error(`Enter a value of at least ${schema.minimum}.`)
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      throw new Error(`Enter a value of at most ${schema.maximum}.`)
    }
  }
}

export function validateAgentSessionFormContent(
  form: AgentSessionForm,
  value: unknown
): AgentSessionFormContent {
  const content = AgentSessionFormContentSchema.parse(value)
  const names = new Set(form.fields.map((field) => field.name))
  if (Object.keys(content).some((name) => !names.has(name))) {
    throw new Error('The response includes an unknown field.')
  }
  for (const field of form.fields) {
    if (!Object.hasOwn(content, field.name)) {
      if (field.required) {
        throw new Error(`${field.schema.title ?? field.name}: Enter a value.`)
      }
      continue
    }
    validateAgentSessionFormField(field, content[field.name])
  }
  return Object.fromEntries(
    Object.entries(content).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  )
}

export function canonicalAgentSessionFormContent(content: AgentSessionFormContent): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(content).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  )
}

export function initialAgentSessionFormDraft(form: AgentSessionForm): AgentSessionFormDraft {
  return new Map<string, string | boolean>(
    form.fields.flatMap<[string, string | boolean]>((field) =>
      field.schema.default === undefined
        ? []
        : [
            [
              field.name,
              typeof field.schema.default === 'number'
                ? String(field.schema.default)
                : field.schema.default
            ]
          ]
    )
  )
}

export function agentSessionFormDraftContent(
  form: AgentSessionForm,
  draft: AgentSessionFormDraft
): AgentSessionFormContent {
  const content = Object.fromEntries(
    form.fields.flatMap<[string, string | number | boolean]>((field) => {
      const value = draft.get(field.name)
      if (value === undefined) {
        return []
      }
      if (field.schema.type === 'number' || field.schema.type === 'integer') {
        if (typeof value !== 'string') {
          throw new Error(`${field.schema.title ?? field.name}: Enter a number.`)
        }
        if (value.trim() === '') {
          return []
        }
        return [[field.name, Number(value)]]
      }
      return [[field.name, value]]
    })
  )
  return validateAgentSessionFormContent(form, content)
}
