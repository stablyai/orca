// NS-03: failed usage reads show a quiet "--" (reason on hover), never a permanent warning.
import { defineFixture } from '../../component-fixtures/component-fixture'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { ProviderSegment } from './StatusBar'

function errorProvider(
  provider: ProviderRateLimits['provider'],
  failureKind: string
): ProviderRateLimits {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal error-state fixture data.
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: 0,
    error: 'usage read failed',
    status: 'error',
    usageMetadata: { failureKind }
  } as unknown as ProviderRateLimits
}

export const calmErrors = defineFixture({
  width: 360,
  render: () => (
    <div className="flex h-6 items-center gap-4 border-t border-border px-3 text-xs">
      <ProviderSegment p={errorProvider('cursor', 'stale-token')} compact={false} display="used" />
      <ProviderSegment p={errorProvider('gemini', 'unknown')} compact={false} display="used" />
    </div>
  )
})
