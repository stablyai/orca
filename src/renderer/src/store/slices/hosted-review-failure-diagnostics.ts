import type { HostedReviewLookupResult } from '../../../../shared/hosted-review'

type UpstreamError = Extract<HostedReviewLookupResult, { kind: 'upstream-error' }>
type HotData = Record<string, unknown> | undefined
type Warn = (message: string, context: Record<string, string>) => void

const REGISTRY_KEY = 'hostedReviewFailureDiagnosticSignatures'
const MAX_ENTRIES = 500

function registryFromHotData(hotData: HotData): Map<string, string> {
  const existing = hotData?.[REGISTRY_KEY]
  if (existing instanceof Map) {
    return existing as Map<string, string>
  }
  const registry = new Map<string, string>()
  if (hotData) {
    hotData[REGISTRY_KEY] = registry
  }
  return registry
}

// Why: Vite retains hot data across reloads, so one upstream outage does not
// restart warning spam every time the renderer accepts an HMR update.
export function createHostedReviewFailureDiagnostics(
  hotData: HotData,
  warn?: Warn
): {
  report(cacheKey: string, repoId: string | undefined, result: UpstreamError): void
  clear(cacheKey: string): void
} {
  const signatures = registryFromHotData(hotData)
  const emitWarning = warn ?? ((message, context) => console.warn(message, context))
  return {
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
