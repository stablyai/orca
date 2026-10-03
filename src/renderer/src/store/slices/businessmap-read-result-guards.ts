import { isIntegrationCredentialDecryptionError } from '../../../../shared/integration-credential-errors'
import type { BusinessmapCard } from '../../../../shared/businessmap-types'
import type { BusinessmapSliceGet, BusinessmapSliceSet } from './businessmap-slice-contract'
import {
  canWriteBusinessmapReadResult,
  getSelectedBusinessmapSiteId,
  looksLikeBusinessmapAuthError,
  markBusinessmapConnectionLost,
  type BusinessmapReadScope
} from './businessmap-read-coordination'

export function canWriteCollectionResult(
  scope: BusinessmapReadScope,
  mutationGeneration: number,
  get: BusinessmapSliceGet,
  readInvalidationGeneration?: number
): boolean {
  return canWriteBusinessmapReadResult(
    scope.contextKey,
    mutationGeneration,
    get().settings,
    scope.explicitSource,
    readInvalidationGeneration
  )
}

export function handleBusinessmapCollectionReadError(
  error: unknown,
  scope: BusinessmapReadScope,
  mutationGeneration: number,
  set: BusinessmapSliceSet,
  get: BusinessmapSliceGet,
  readInvalidationGeneration?: number
): BusinessmapCard[] {
  if (
    isIntegrationCredentialDecryptionError(error) &&
    canWriteCollectionResult(scope, mutationGeneration, get, readInvalidationGeneration)
  ) {
    void get().checkBusinessmapConnection()
  } else if (
    looksLikeBusinessmapAuthError(error) &&
    canWriteCollectionResult(scope, mutationGeneration, get, readInvalidationGeneration)
  ) {
    markBusinessmapConnectionLost(set, scope)
  }
  if (isIntegrationCredentialDecryptionError(error) || looksLikeBusinessmapAuthError(error)) {
    return []
  }
  throw error
}

// Why: an explicit source runtime has no focused-site state; never borrow it.
export function resolveReadSiteId(
  options: { siteId?: string | null; sourceContext?: unknown } | undefined,
  get: BusinessmapSliceGet
): string | null {
  if (options && 'siteId' in options && options.siteId !== undefined) {
    return options.siteId
  }
  if (options && 'sourceContext' in options && options.sourceContext != null) {
    return null
  }
  return getSelectedBusinessmapSiteId(get().businessmapStatus)
}
