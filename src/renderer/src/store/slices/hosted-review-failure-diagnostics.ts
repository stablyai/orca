import type { HostedReviewLookupResult } from '../../../../shared/hosted-review'

type UpstreamError = Extract<HostedReviewLookupResult, { kind: 'upstream-error' }>
type HotData = Record<string, unknown> | undefined
type Warn = (message: string, context: Record<string, string>) => void
type DiagnosticRegistry = {
  signatures: Map<string, string>
  requestGenerations: Map<string, number>
  nextRequestGeneration: number
}

const REGISTRY_KEY = 'hostedReviewFailureDiagnosticSignatures'
const MAX_ENTRIES = 500

function isDiagnosticRegistry(value: unknown): value is DiagnosticRegistry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'signatures' in value &&
    value.signatures instanceof Map &&
    'requestGenerations' in value &&
    value.requestGenerations instanceof Map &&
    'nextRequestGeneration' in value &&
    typeof value.nextRequestGeneration === 'number'
  )
}

function registryFromHotData(hotData: HotData): DiagnosticRegistry {
  const existing = hotData?.[REGISTRY_KEY]
  if (isDiagnosticRegistry(existing)) {
    return existing
  }
  const registry: DiagnosticRegistry = {
    // Why: preserve signatures created by versions before request ownership
    // joined this HMR-persistent registry.
    signatures: existing instanceof Map ? (existing as Map<string, string>) : new Map(),
    requestGenerations: new Map(),
    nextRequestGeneration: 0
  }
  if (hotData) {
    hotData[REGISTRY_KEY] = registry
  }
  return registry
}

// Why: requests can outlive an HMR update, so hot data keeps request ownership
// and warning deduplication coherent across old and new module instances.
export function createHostedReviewFailureDiagnostics(
  hotData: HotData,
  warn?: Warn
): {
  claimRequest(cacheKey: string): number
  ownsRequest(cacheKey: string, generation: number): boolean
  finishRequest(cacheKey: string, generation: number): void
  requestGenerationCount(): number
  clearRequestGenerations(): void
  report(cacheKey: string, repoId: string | undefined, result: UpstreamError): void
  clear(cacheKey: string): void
} {
  const registry = registryFromHotData(hotData)
  const { signatures, requestGenerations } = registry
  const emitWarning = warn ?? ((message, context) => console.warn(message, context))
  return {
    claimRequest: (cacheKey) => {
      const generation = ++registry.nextRequestGeneration
      requestGenerations.set(cacheKey, generation)
      return generation
    },
    ownsRequest: (cacheKey, generation) => requestGenerations.get(cacheKey) === generation,
    finishRequest: (cacheKey, generation) => {
      if (requestGenerations.get(cacheKey) === generation) {
        requestGenerations.delete(cacheKey)
      }
    },
    requestGenerationCount: () => requestGenerations.size,
    clearRequestGenerations: () => {
      requestGenerations.clear()
      registry.nextRequestGeneration = 0
    },
    report: (cacheKey, repoId, result) => {
      const signature = `${result.provider}:${result.errorType}`
      if (signatures.get(cacheKey) === signature) {
        return
      }
      signatures.delete(cacheKey)
      signatures.set(cacheKey, signature)
      while (signatures.size > MAX_ENTRIES) {
        const oldestKey = signatures.keys().next().value
        if (oldestKey === undefined) {
          break
        }
        signatures.delete(oldestKey)
      }
      emitWarning('[hosted-review] lookup unavailable', {
        repoId: repoId ?? 'path-only',
        provider: result.provider,
        errorType: result.errorType
      })
    },
    clear: (cacheKey) => signatures.delete(cacheKey)
  }
}

export const hostedReviewFailureDiagnostics = createHostedReviewFailureDiagnostics(
  import.meta.hot?.data
)
