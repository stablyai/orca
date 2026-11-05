import { surfaceExecutionProvenanceSchema } from './surface-execution-provenance'
import { z } from 'zod'
import type { SurfaceKey, SurfaceLeaf, WorkspaceSurface } from './surface-content'

const id = z.string().min(1)
export const surfaceRunTargetSchema = z.strictObject({
  hostId: id,
  workspaceId: id,
  hostTabId: id,
  occurrence: id,
  leafId: id,
  leafOccurrence: id,
  runId: id
})
export type SurfaceRunTarget = z.infer<typeof surfaceRunTargetSchema>

export const surfaceResourceSchema = z.strictObject({ ptyId: id, incarnationId: id.optional() })
export type SurfaceResource = z.infer<typeof surfaceResourceSchema>

export const surfaceAllocationSchema = z.strictObject({
  allocationId: id,
  target: surfaceRunTargetSchema,
  resourceId: id.nullable(),
  executorId: id.nullable().default(null),
  provenance: surfaceExecutionProvenanceSchema.nullable().optional(),
  expiresAt: z.int().nonnegative(),
  resource: surfaceResourceSchema.nullable(),
  decision: z.enum(['pending', 'committed', 'aborting'])
})
export type SurfaceAllocation = z.infer<typeof surfaceAllocationSchema>

export type SurfaceAllocationOutcome =
  | { status: 'accepted'; allocation: SurfaceAllocation }
  | { status: 'conflict'; code: 'pane_changed' | 'allocation_changed' | 'allocation_expired' }

export type SurfaceAllocationAcknowledgment = {
  hostId: string
  allocationId: string
  executorId?: string
} & (
  | { decision: 'committed'; resource: SurfaceResource }
  | { decision: 'aborting'; proof: 'stopped_and_fenced' }
)

export function runTargetOf(surface: WorkspaceSurface, leafId: string): SurfaceRunTarget | null {
  const leaf = surface.content?.kind === 'terminal' ? surface.content.leaves[leafId] : undefined
  return leaf
    ? {
        hostId: surface.hostId,
        workspaceId: surface.workspaceId,
        hostTabId: surface.hostTabId,
        occurrence: surface.occurrence,
        leafId,
        leafOccurrence: leaf.occurrence,
        runId: leaf.runId
      }
    : null
}

/** Adoption removes delivery debt; the bound leaf retains its exact physical owner. */
export function boundSurfaceRunAllocation(
  surface: WorkspaceSurface,
  leafId: string
): SurfaceAllocation | null {
  const leaf = surface.content?.kind === 'terminal' ? surface.content.leaves[leafId] : undefined
  if (!leaf?.facts.ptyId) {
    return null
  }
  return {
    allocationId: leaf.runId,
    target: runTargetOf(surface, leafId)!,
    resourceId: leaf.facts.ptyId,
    executorId: leaf.executorId ?? null,
    provenance: leaf.provenance ?? null,
    expiresAt: 0,
    resource: {
      ptyId: leaf.facts.ptyId,
      ...(leaf.facts.incarnationId ? { incarnationId: leaf.facts.incarnationId } : {})
    },
    decision: 'committed'
  }
}

export function runLeafOf(
  surface: WorkspaceSurface | null,
  target: SurfaceRunTarget
): SurfaceLeaf | null {
  const current = surface ? runTargetOf(surface, target.leafId) : null
  return current && sameRunTarget(current, target) && surface?.content?.kind === 'terminal'
    ? surface.content.leaves[target.leafId]!
    : null
}

export function sameRunTarget(a: SurfaceRunTarget, b: SurfaceRunTarget): boolean {
  return (
    sameSurfaceKey(a, b) &&
    a.occurrence === b.occurrence &&
    a.leafId === b.leafId &&
    a.leafOccurrence === b.leafOccurrence &&
    a.runId === b.runId
  )
}

function sameSurfaceKey(a: SurfaceKey, b: SurfaceKey): boolean {
  return a.hostId === b.hostId && a.workspaceId === b.workspaceId && a.hostTabId === b.hostTabId
}
