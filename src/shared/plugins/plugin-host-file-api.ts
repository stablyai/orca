import { z } from 'zod'
import type { PluginHostMethodSpec } from './plugin-host-api'

export const PLUGIN_WORKSPACE_REF_KEY_MAX_LENGTH = 1024
export const PLUGIN_RELATIVE_PATH_MAX_LENGTH = 4096
export const PLUGIN_FILE_CONTENT_MAX_LENGTH = 1024 * 1024
export const PLUGIN_DIRECTORY_ENTRY_LIMIT = 2000
export const PLUGIN_WORKSPACE_LIST_LIMIT = 1000

const workspaceRefValueSchema = z
  .string()
  .min(1)
  .max(PLUGIN_WORKSPACE_REF_KEY_MAX_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._~%-]*$/)

const decodeWorkspaceRefValue = (
  value: string,
  context: z.RefinementCtx
): string | typeof z.NEVER => {
  const encoded = workspaceRefValueSchema.safeParse(value)
  if (!encoded.success) {
    context.addIssue({ code: 'custom', message: 'invalid workspace reference' })
    return z.NEVER
  }
  try {
    return decodeURIComponent(encoded.data)
  } catch {
    context.addIssue({ code: 'custom', message: 'invalid workspace reference encoding' })
    return z.NEVER
  }
}

export const pluginWorkspaceRefWireSchema = z.union([
  z
    .string()
    .max(PLUGIN_WORKSPACE_REF_KEY_MAX_LENGTH + 'identity:'.length)
    .regex(/^identity:[A-Za-z0-9][A-Za-z0-9._~%-]*$/),
  z
    .string()
    .max(PLUGIN_WORKSPACE_REF_KEY_MAX_LENGTH + 'id:'.length)
    .regex(/^id:[A-Za-z0-9][A-Za-z0-9._~%-]*$/)
])

export const pluginWorkspaceRefSchema = z.union([
  z
    .string()
    .regex(/^identity:/)
    .transform((value, context) => {
      const identity = decodeWorkspaceRefValue(value.slice('identity:'.length), context)
      return identity === z.NEVER ? z.NEVER : { type: 'worktree' as const, identity }
    }),
  z
    .string()
    .regex(/^id:/)
    .transform((value, context) => {
      const id = decodeWorkspaceRefValue(value.slice('id:'.length), context)
      return id === z.NEVER ? z.NEVER : { type: 'folder' as const, id }
    })
])

export type PluginWorkspaceRef = z.infer<typeof pluginWorkspaceRefSchema>

const relativePathSchema = z
  .string()
  .min(1)
  .max(PLUGIN_RELATIVE_PATH_MAX_LENGTH)
  .refine((path) => !path.includes('\0'), 'path contains NUL')
  .refine((path) => !/^(?:[/\\]|[A-Za-z]:[\\/])/.test(path), 'path must be relative')
  .refine(
    (path) => !path.split(/[\\/]/).some((segment) => segment === '..'),
    'path traversal is not allowed'
  )

const fileParams = z
  .object({ workspaceRef: pluginWorkspaceRefSchema, relativePath: relativePathSchema })
  .strict()
const fileReadResult = z
  .object({ content: z.string().max(PLUGIN_FILE_CONTENT_MAX_LENGTH), encoding: z.literal('utf8') })
  .strict()
const fileStatResult = z
  .object({
    size: z.number().nonnegative(),
    isDirectory: z.boolean(),
    mtime: z.number().nullable()
  })
  .strict()
const directoryEntrySchema = z
  .object({ name: z.string().max(512), isDirectory: z.boolean() })
  .strict()
const fileReadDirResult = z
  .object({ entries: z.array(directoryEntrySchema).max(PLUGIN_DIRECTORY_ENTRY_LIMIT) })
  .strict()
const workspaceListResult = z
  .object({
    workspaces: z
      .array(
        z
          .object({
            ref: pluginWorkspaceRefWireSchema,
            hostId: z.string().max(1024),
            branch: z.string().max(512).optional(),
            displayName: z.string().max(512),
            workspaceStatus: z.string().max(128).optional(),
            comment: z.string().max(4096).optional()
          })
          .strict()
      )
      .max(PLUGIN_WORKSPACE_LIST_LIMIT)
  })
  .strict()

const fileSpec = (
  name: string,
  capability: 'files:read' | 'workspace:list',
  params: z.ZodTypeAny,
  result: z.ZodTypeAny
): PluginHostMethodSpec => ({
  name,
  since: '1.0',
  scope: 'active-worktree',
  stability: 'experimental',
  capability,
  authorization: capability === 'files:read' ? 'resource' : 'capability-only',
  mutation: false,
  panel: false,
  params,
  result
})

export const PLUGIN_HOST_FILE_API_SPECS: readonly PluginHostMethodSpec[] = [
  fileSpec('files.read', 'files:read', fileParams, fileReadResult),
  fileSpec('files.stat', 'files:read', fileParams, fileStatResult),
  fileSpec('files.readDir', 'files:read', fileParams, fileReadDirResult),
  fileSpec(
    'workspace.list',
    'workspace:list',
    z.object({}).strict().optional(),
    workspaceListResult
  )
]
