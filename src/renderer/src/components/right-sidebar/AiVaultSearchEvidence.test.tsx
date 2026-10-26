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
        snippet: '<script>[[needle]]</script> unmatched [['
      }
    }
    const { container } = render(<AiVaultSearchEvidence hit={hit} />)

    expect(screen.getByText('You')).toBeTruthy()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('mark')?.textContent).toBe('needle')
    expect(container.textContent).toContain('<script>needle</script> unmatched [[')
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

  it('shortens long leading context without losing any highlights or following text', () => {
    const { container } = render(
      <AiVaultSearchEvidence
        hit={{
          ...searchHit(),
          evidence: {
            role: 'assistant',
            timestamp: null,
            snippet:
              '…/Users/example/Documents/projects/application/apps/server/src/server.ts:534).\n\n**Codex, [[inspected with REA]]:** Version 26 contains [[three]] relevant pieces.'
          }
        }}
      />
    )

    expect(container.textContent).toBe(
      'Agent: …**Codex, inspected with REA:** Version 26 contains three relevant pieces.'
    )
    expect(Array.from(container.querySelectorAll('mark'), (mark) => mark.textContent)).toEqual([
      'inspected with REA',
      'three'
    ])
  })

  it.each([
    [`${'😀'.repeat(40)}x[[needle]]`, '…needle'],
    ['Earlier analysis. 😀😀😀😀 before [[needle]]', '…😀😀😀😀 before needle']
  ])('shortens Unicode context at word boundaries: %s', (snippet, expected) => {
    const { container } = render(
      <AiVaultSearchEvidence
        hit={{
          ...searchHit(),
          evidence: { role: 'assistant', timestamp: null, snippet }
        }}
      />
    )

    expect(container.textContent?.isWellFormed()).toBe(true)
    expect(container.textContent).toBe(`Agent: ${expected}`)
    expect(container.querySelector('mark')?.textContent).toBe('needle')
  })

  it('preserves a whole word at the context boundary, including a negation', () => {
    const { container } = render(
      <AiVaultSearchEvidence
        hit={{
          ...searchHit(),
          evidence: {
            role: 'assistant',
            timestamp: null,
            snippet: 'Earlier analysis. Never trust [[safe]].'
          }
        }}
      />
    )

    expect(container.textContent).toBe('Agent: …Never trust safe.')
    expect(container.querySelector('mark')?.textContent).toBe('safe')
  })

  it('preserves an unmarked preview from a host without highlight markers', () => {
    const snippet = 'A long preview without paired highlight markers must remain intact [['
    const { container } = render(
      <AiVaultSearchEvidence
        hit={{
          ...searchHit(),
          evidence: { role: 'assistant', timestamp: null, snippet }
        }}
      />
    )

    expect(container.textContent).toBe(`Agent: ${snippet}`)
    expect(container.querySelector('mark')).toBeNull()
  })
})
