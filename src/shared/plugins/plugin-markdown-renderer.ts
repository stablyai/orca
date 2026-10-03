import { z } from 'zod'
import { pluginCommandIdSchema } from './plugin-manifest-fields'
import { isSafePluginRelativePath } from './plugin-path-safety'

export const PLUGIN_MARKDOWN_RENDERER_LIMIT = 16
export const PLUGIN_MARKDOWN_CODE_MAX_LENGTH = 64 * 1024
export const PLUGIN_MARKDOWN_OUTPUT_MAX_BYTES = 512 * 1024
export const PLUGIN_MARKDOWN_ROW_LIMIT = 500
export const PLUGIN_MARKDOWN_COLUMN_LIMIT = 32
export const PLUGIN_MARKDOWN_REFERENCE_LIMIT = 128

export const pluginMarkdownLanguageSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/, 'must be a lowercase fenced language')
  .refine((language) => language !== 'mermaid', 'reserved native fenced language')

export const pluginMarkdownRendererContributionSchema = z
  .object({ language: pluginMarkdownLanguageSchema, commandId: pluginCommandIdSchema })
  .strict()

const identitySchema = z.string().min(1).max(4096)
const revisionSchema = z.string().min(1).max(128)

export const pluginMarkdownSourceSchema = z
  .object({
    runtimeId: identitySchema,
    worktreeId: identitySchema,
    documentPath: identitySchema,
    fileId: identitySchema,
    workspacePath: identitySchema
  })
  .strict()

export const pluginMarkdownSourceRequestSchema = z
  .object({
    fileId: identitySchema,
    documentPath: identitySchema,
    worktreeId: identitySchema,
    runtimeEnvironmentId: identitySchema.nullable()
  })
  .strict()

export const pluginMarkdownCancelRequestSchema = z.object({ sessionId: revisionSchema }).strict()

export const pluginMarkdownRenderRequestSchema = z
  .object({
    language: pluginMarkdownLanguageSchema,
    code: z.string().max(PLUGIN_MARKDOWN_CODE_MAX_LENGTH),
    source: pluginMarkdownSourceSchema,
    sessionId: revisionSchema,
    knownRevision: revisionSchema.optional()
  })
  .strict()

export const pluginMarkdownReferenceSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (path) => !path.includes('\\') && isSafePluginRelativePath(path),
        'must be a safe relative note path'
      ),
    base: z.enum(['document', 'workspace'])
  })
  .strict()

export const pluginMarkdownCellSchema = z
  .object({
    text: z.string().max(4096),
    state: z.enum(['normal', 'missing', 'error']).optional(),
    reference: pluginMarkdownReferenceSchema.optional()
  })
  .strict()

export const pluginMarkdownOutputSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('table'),
        columns: z.array(z.string().max(256)).min(1).max(PLUGIN_MARKDOWN_COLUMN_LIMIT),
        rows: z
          .array(z.array(pluginMarkdownCellSchema).max(PLUGIN_MARKDOWN_COLUMN_LIMIT))
          .max(PLUGIN_MARKDOWN_ROW_LIMIT)
      })
      .strict()
      .refine((table) => table.rows.every((row) => row.length === table.columns.length), {
        message: 'table rows must match column count'
      }),
    z
      .object({
        kind: z.literal('list'),
        items: z.array(pluginMarkdownCellSchema).max(PLUGIN_MARKDOWN_ROW_LIMIT)
      })
      .strict(),
    z.object({ kind: z.literal('text'), text: z.string().max(64 * 1024) }).strict(),
    z.object({ kind: z.literal('error'), message: z.string().max(4096) }).strict()
  ])
  .refine((output) => {
    const cells =
      output.kind === 'table' ? output.rows.flat() : output.kind === 'list' ? output.items : []
    return cells.filter((cell) => cell.reference).length <= PLUGIN_MARKDOWN_REFERENCE_LIMIT
  }, 'too many note references')

export const pluginMarkdownWorkerResultSchema = z
  .object({
    sessionId: revisionSchema,
    revision: revisionSchema,
    output: pluginMarkdownOutputSchema
  })
  .strict()

export type PluginMarkdownRendererContribution = z.infer<
  typeof pluginMarkdownRendererContributionSchema
>
export type PluginMarkdownSource = z.infer<typeof pluginMarkdownSourceSchema>
export type PluginMarkdownSourceRequest = z.infer<typeof pluginMarkdownSourceRequestSchema>
export type PluginMarkdownSourceResult =
  | { status: 'resolved'; source: PluginMarkdownSource }
  | { status: 'unavailable'; reason: 'unsupported-context' }
export type PluginMarkdownRenderRequest = z.infer<typeof pluginMarkdownRenderRequestSchema>
export type PluginMarkdownReference = z.infer<typeof pluginMarkdownReferenceSchema>
export type PluginMarkdownCell = z.infer<typeof pluginMarkdownCellSchema>
export type PluginMarkdownOutput = z.infer<typeof pluginMarkdownOutputSchema>
export type PluginMarkdownWorkerResult = z.infer<typeof pluginMarkdownWorkerResultSchema>

export type PluginMarkdownRendererRegistration = {
  language: string
  pluginKey: string
  available: boolean
}

export type PluginMarkdownRenderResult =
  | ({ status: 'rendered'; pluginKey: string } & PluginMarkdownWorkerResult)
  | {
      status: 'unavailable'
      reason:
        | 'missing-provider'
        | 'disabled-provider'
        | 'ambiguous-provider'
        | 'unsupported-context'
    }
  | {
      status: 'error'
      code: 'invalid-request' | 'invalid-output' | 'provider-error' | 'stale-context'
      message: string
    }
