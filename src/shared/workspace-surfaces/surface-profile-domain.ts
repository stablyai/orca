import { z } from 'zod'
import { surfaceAllocationSchema } from './surface-allocation'
import { surfaceCommandOutcomeSchema } from './surface-command'
import { workspaceSurfaceSchema } from './surface-schema'

export const WORKSPACE_SURFACE_DOMAIN = 'workspaceSurfaces'

const id = z.string().min(1)
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/)
export const surfaceProjectionSchema = z.strictObject({
  projectionId: id,
  revision: z.int().nonnegative(),
  fingerprint,
  surfaces: z.array(workspaceSurfaceSchema)
})
export type SurfaceProjection = z.infer<typeof surfaceProjectionSchema>

export const surfaceCommandReceiptSchema = z.strictObject({
  callerId: id,
  commandId: id,
  fingerprint: id,
  expiresAt: z.int().nonnegative(),
  outcome: surfaceCommandOutcomeSchema
})

export const surfaceChatProjectionSchema = z.strictObject({
  commitId: id,
  revision: z.int().nonnegative(),
  recorded: z.boolean(),
  tabs: z.array(z.strictObject({ tabId: id, sessionId: id })),
  surfaces: z.array(workspaceSurfaceSchema)
})
export type SurfaceChatProjection = z.infer<typeof surfaceChatProjectionSchema>

const host = z.strictObject({
  terminalInitialized: z.boolean(),
  chatInitialization: z.enum(['unknown', 'verified']),
  revision: z.int().nonnegative(),
  surfaces: z.array(workspaceSurfaceSchema),
  receipts: z.array(surfaceCommandReceiptSchema),
  allocations: z.array(surfaceAllocationSchema),
  terminalBaselines: z.record(id, surfaceProjectionSchema),
  chatBaseline: surfaceChatProjectionSchema.optional(),
  retainedReferences: z.array(
    z.strictObject({
      workspaceId: id,
      kind: z.enum(['terminal', 'terminal-layout', 'pane', 'agent-session']),
      id,
      raw: z.json()
    })
  ),
  identityMappings: z.array(
    z.strictObject({
      workspaceId: id,
      kind: z.enum(['host-tab', 'terminal-entity', 'leaf']),
      previousId: id,
      currentId: id
    })
  )
})
export type SurfaceHostDomain = z.infer<typeof host>

/** The root document travels through released JSON saves; SQL indices can always be rebuilt. */
export const surfaceProfileDomainSchema = z
  .strictObject({
    version: z.literal(1),
    hosts: z.record(id, host)
  })
  .superRefine((domain, context) => {
    for (const [hostId, state] of Object.entries(domain.hosts)) {
      const keys = new Set<string>()
      for (const surface of state.surfaces) {
        const key = JSON.stringify([surface.workspaceId, surface.hostTabId])
        if (surface.hostId !== hostId || keys.has(key)) {
          context.addIssue({ code: 'custom', message: 'surface domain identity is inconsistent' })
        }
        keys.add(key)
      }
      if (state.allocations.some((allocation) => allocation.target.hostId !== hostId)) {
        context.addIssue({ code: 'custom', message: 'surface allocation host is inconsistent' })
      }
    }
  })
export type SurfaceProfileDomain = z.infer<typeof surfaceProfileDomainSchema>

export function emptySurfaceProfileDomain(): SurfaceProfileDomain {
  return { version: 1, hosts: {} }
}

export function emptySurfaceHostDomain(): SurfaceHostDomain {
  return {
    terminalInitialized: false,
    chatInitialization: 'unknown',
    revision: 0,
    surfaces: [],
    receipts: [],
    allocations: [],
    terminalBaselines: {},
    retainedReferences: [],
    identityMappings: []
  }
}
