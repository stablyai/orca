// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { searchHit } from '../../../../shared/ai-vault-search-test-fixture'
import { AiVaultSearchEvidence } from './AiVaultSearchEvidence'

afterEach(cleanup)

describe('AiVaultSearchEvidence', () => {
  it('renders marker text as React content and highlights only paired markers', () => {
    const hit = {
      ...searchHit(),
      evidence: {
        role: 'user' as const,
        timestamp: null,
        snippet: '<script>safe</script> [[needle]] unmatched [['
      }
    }
    const { container } = render(<AiVaultSearchEvidence hit={hit} />)

    expect(screen.getByText('You')).toBeTruthy()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('mark')?.textContent).toBe('needle')
    expect(container.textContent).toContain('<script>safe</script> needle unmatched [[')
  })

  it('describes metadata matches and missing transcript sources honestly', () => {
    render(
      <AiVaultSearchEvidence
        hit={{ ...searchHit(), evidence: null, source: { presence: 'missing' } }}
      />
    )

    expect(screen.getByText('Match in session metadata')).toBeTruthy()
    expect(screen.getByText('Transcript is no longer available')).toBeTruthy()
  })
})
