import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { ProviderLetterBadge } from './StatusBarProviderSegment'

function zaiLimits(status: ProviderRateLimits['status']): ProviderRateLimits {
  return {
    provider: 'zai',
    session: null,
    weekly: null,
    updatedAt: 0,
    error: null,
    status
  }
}

describe('ProviderLetterBadge for Z.AI', () => {
  it('renders the single-letter Z badge for zai', () => {
    const markup = renderToStaticMarkup(<ProviderLetterBadge p={zaiLimits('ok')} />)
    expect(markup).toContain('>Z<')
  })

  it('keeps the has-data dot logic for zai snapshots', () => {
    const empty = renderToStaticMarkup(<ProviderLetterBadge p={zaiLimits('ok')} />)
    const withData = renderToStaticMarkup(
      <ProviderLetterBadge
        p={{
          ...zaiLimits('ok'),
          weekly: { usedPercent: 10, windowMinutes: 10080, resetsAt: null, resetDescription: null }
        }}
      />
    )
    // The dot carries the has-data state; the letter stays constant.
    expect(empty).not.toEqual(withData)
    expect(withData).toContain('>Z<')
  })
})
