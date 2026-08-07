import type { LocalNetworkConnectionTestResult } from '../../../../shared/developer-permissions-types'

const STORAGE_KEY = 'orca.developer-permissions.local-network-last-success.v1'

export type LocalNetworkConnectionSuccess = Pick<
  LocalNetworkConnectionTestResult,
  'host' | 'port' | 'testedAt'
>

function isSavedSuccess(value: unknown): value is LocalNetworkConnectionSuccess {
  if (!value || typeof value !== 'object') {
    return false
  }
  const candidate = value as Partial<LocalNetworkConnectionSuccess>
  return (
    typeof candidate.host === 'string' &&
    candidate.host.length > 0 &&
    Number.isInteger(candidate.port) &&
    candidate.port! >= 1 &&
    candidate.port! <= 65_535 &&
    typeof candidate.testedAt === 'number' &&
    Number.isFinite(candidate.testedAt)
  )
}

export function loadLocalNetworkConnectionSuccess(): LocalNetworkConnectionSuccess | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return null
    }
    const parsed: unknown = JSON.parse(raw)
    return isSavedSuccess(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function saveLocalNetworkConnectionSuccess(success: LocalNetworkConnectionSuccess): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(success))
  } catch {
    // The live result remains useful when browser storage is unavailable.
  }
}
