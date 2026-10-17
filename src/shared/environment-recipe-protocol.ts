import { z } from 'zod'
import { isRuntimePathAbsolute } from './cross-platform-path'
import { assertJsonTextStructureWithinLimits } from './json-text-structure-limit'
import { isQualifiedPluginKey } from './plugins/plugin-tab-key'
import { isPluginManifestId } from './plugins/plugin-id-format'

export const ENVIRONMENT_RECIPE_ACTIONS = [
  'create',
  'delete',
  'sleep',
  'list',
  'resume',
  'archive'
] as const
export const ENVIRONMENT_RECIPE_OUTPUT_BYTES = 512 * 1024
export const ENVIRONMENT_RECIPE_INPUT_BYTES = 32 * 1024
export const ENVIRONMENT_RECIPE_RESOURCE_LIMIT = 256

const text = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine(
      (value) =>
        Array.from(value).every((character) => {
          const code = character.charCodeAt(0)
          return code >= 32 && code !== 127
        }),
      'control characters are not allowed'
    )
const providerId = text(256).refine((value) => {
  const [pluginKey, recipeId, ...extra] = value.split('/')
  return (
    extra.length === 0 &&
    isQualifiedPluginKey(pluginKey!) &&
    (recipeId === undefined || isPluginManifestId(recipeId))
  )
}, 'expected a publisher-qualified provider identity')
const resourceId = text(256)
const parameters = z
  .record(text(64), text(2048))
  .refine((value) => Object.keys(value).length <= 32, 'too many parameters')
const requestIdentity = z.strictObject({
  protocolVersion: z.literal(1),
  operationId: z.uuid(),
  providerId
})

export const environmentRecipeRequestSchema = z.discriminatedUnion('action', [
  requestIdentity.extend({ action: z.literal('create'), parameters }),
  requestIdentity.extend({ action: z.literal('list'), cursor: text(2048).optional() }),
  requestIdentity.extend({
    action: z.enum(['delete', 'sleep', 'resume', 'archive']),
    resourceId,
    expectedRevision: text(256)
  })
])

const sshConnection = z.strictObject({
  type: z.literal('ssh'),
  host: text(253).refine(
    (value) => !value.startsWith('-') && !/\s/.test(value),
    'invalid SSH host'
  ),
  port: z.number().int().min(1).max(65535),
  username: text(128).refine(
    (value) => !value.startsWith('-') && !/\s/.test(value),
    'invalid SSH user'
  ),
  configHost: text(253)
    .refine((value) => !value.startsWith('-') && !/\s/.test(value), 'invalid SSH config host')
    .optional(),
  projectRoot: text(4096).refine(isRuntimePathAbsolute, 'expected an absolute host path')
})

export const environmentRecipeResourceSchema = z
  .strictObject({
    id: resourceId,
    name: text(256),
    revision: text(256),
    lifetime: z.enum(['long-lived', 'ephemeral']),
    state: z.enum(['creating', 'running', 'sleeping', 'archived', 'deleted', 'error', 'unknown']),
    connection: sshConnection.optional()
  })
  .superRefine((resource, context) => {
    if (resource.connection && resource.state !== 'running') {
      context.addIssue({
        code: 'custom',
        path: ['connection'],
        message: 'only running resources can advertise a connection'
      })
    }
  })

const responseIdentity = requestIdentity.extend({ action: z.enum(ENVIRONMENT_RECIPE_ACTIONS) })
export const environmentRecipeResponseSchema = z
  .discriminatedUnion('kind', [
    responseIdentity.extend({
      kind: z.literal('resource'),
      resource: environmentRecipeResourceSchema
    }),
    responseIdentity.extend({
      kind: z.literal('inventory'),
      resources: z.array(environmentRecipeResourceSchema).max(ENVIRONMENT_RECIPE_RESOURCE_LIMIT),
      nextCursor: text(2048).optional()
    }),
    responseIdentity.extend({
      kind: z.literal('error'),
      code: z.enum([
        'conflict',
        'not-found',
        'authentication-required',
        'unsupported',
        'unavailable'
      ]),
      message: text(1024)
    })
  ])
  .superRefine((response, context) => {
    if (response.kind === 'inventory') {
      if (response.action !== 'list') {
        context.addIssue({
          code: 'custom',
          path: ['action'],
          message: 'inventory is only a list result'
        })
      }
      const ids = response.resources.map((resource) => resource.id)
      if (new Set(ids).size !== ids.length) {
        context.addIssue({
          code: 'custom',
          path: ['resources'],
          message: 'duplicate resource identity'
        })
      }
    }
    if (response.kind === 'resource' && response.action === 'list') {
      context.addIssue({ code: 'custom', path: ['kind'], message: 'list requires an inventory' })
    }
  })

export type EnvironmentRecipeAction = (typeof ENVIRONMENT_RECIPE_ACTIONS)[number]
export type EnvironmentRecipeRequest = z.infer<typeof environmentRecipeRequestSchema>
export type EnvironmentRecipeResource = z.infer<typeof environmentRecipeResourceSchema>
export type EnvironmentRecipeResponse = z.infer<typeof environmentRecipeResponseSchema>

export function parseEnvironmentRecipeResponse(
  stdout: string,
  request: EnvironmentRecipeRequest
): EnvironmentRecipeResponse {
  if (new TextEncoder().encode(stdout).byteLength > ENVIRONMENT_RECIPE_OUTPUT_BYTES) {
    throw new Error('Environment recipe response exceeds its byte limit')
  }
  assertJsonTextStructureWithinLimits(stdout, { nestingDepth: 16, structuralTokens: 32 * 1024 })
  const result = environmentRecipeResponseSchema.parse(JSON.parse(stdout))
  if (
    result.operationId !== request.operationId ||
    result.providerId !== request.providerId ||
    result.action !== request.action
  ) {
    throw new Error('Environment recipe response does not belong to this operation')
  }
  if (result.kind === 'resource') {
    if ('resourceId' in request && result.resource.id !== request.resourceId) {
      throw new Error('Environment recipe response names another resource')
    }
    const expectedState =
      request.action === 'delete'
        ? 'deleted'
        : request.action === 'sleep'
          ? 'sleeping'
          : request.action === 'archive'
            ? 'archived'
            : request.action === 'resume' || request.action === 'create'
              ? 'running'
              : null
    if (expectedState && result.resource.state !== expectedState) {
      throw new Error('Environment recipe response did not confirm the requested transition')
    }
  }
  return result
}
