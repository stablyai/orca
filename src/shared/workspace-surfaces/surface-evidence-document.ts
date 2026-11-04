import { z } from 'zod'
import { surfaceProfileDomainSchema } from './surface-profile-domain'

export const SURFACE_EVIDENCE_PREFIX = 'workspaceSurfaceEvidence/'
const host = surfaceProfileDomainSchema.shape.hosts.valueType
export const surfaceEvidenceDocumentSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    version: z.literal(1),
    hostId: z.string().min(1),
    kind: z.literal('reference'),
    value: host.shape.retainedReferences.element
  }),
  z.strictObject({
    version: z.literal(1),
    hostId: z.string().min(1),
    kind: z.literal('mapping'),
    sequence: z.number().int().nonnegative(),
    value: host.shape.identityMappings.element
  })
])
export type SurfaceEvidenceDocument = z.infer<typeof surfaceEvidenceDocumentSchema>

export function isSurfaceEvidenceDomain(domain: string): boolean {
  return domain.startsWith(SURFACE_EVIDENCE_PREFIX)
}

export function surfaceEvidenceScope(hostId: string, workspaceId: string): string {
  return `${SURFACE_EVIDENCE_PREFIX}${encodeURIComponent(hostId)}/${encodeURIComponent(workspaceId)}/`
}

export function surfaceMappingPrefix(
  hostId: string,
  workspaceId: string,
  kind: string,
  previousId: string
): string {
  return `${surfaceEvidenceScope(hostId, workspaceId)}mapping/${encodeURIComponent(kind)}/${encodeURIComponent(previousId)}/`
}

export function surfaceEvidenceKey(
  document: SurfaceEvidenceDocument,
  digest: (payload: string) => string
): string {
  return document.kind === 'mapping'
    ? `${surfaceMappingPrefix(document.hostId, document.value.workspaceId, document.value.kind, document.value.previousId)}${String(document.sequence).padStart(16, '0')}`
    : `${surfaceEvidenceScope(document.hostId, document.value.workspaceId)}reference/${digest(JSON.stringify(document))}`
}
