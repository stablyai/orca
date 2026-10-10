import { describe, expect, it } from 'vitest'
import { createAccumulator } from './text-search'
import { RipgrepSearchDiagnostics } from './ripgrep-search-diagnostics'

describe('ripgrep search diagnostics', () => {
  it('reports invalid regex diagnostics instead of an empty successful search', () => {
    const diagnostics = new RipgrepSearchDiagnostics()
    diagnostics.append(Buffer.from('regex parse error: unclosed character class'))
    expect(diagnostics.failure(2, null, createAccumulator())?.message).toContain(
      'unclosed character class'
    )
  })

  it('limits retained diagnostics even for large stderr chunks', () => {
    const diagnostics = new RipgrepSearchDiagnostics()
    diagnostics.append('x'.repeat(100_000))
    diagnostics.append('must not be retained')
    const error = diagnostics.failure(2, null, createAccumulator())
    expect(error?.message).toBe(`Search failed (2): ${'x'.repeat(4096)}`)
  })

  it('marks permission-error results as incomplete', () => {
    const acc = createAccumulator()
    acc.totalMatches = 1
    expect(new RipgrepSearchDiagnostics().failure(2, null, acc)).toBeNull()
    expect(acc.truncated).toBe(true)
  })

  it('distinguishes a killed search from intentional truncation', () => {
    const diagnostics = new RipgrepSearchDiagnostics()
    const acc = createAccumulator()
    expect(diagnostics.failure(null, 'SIGTERM', acc)).toBeInstanceOf(Error)
    acc.truncated = true
    expect(diagnostics.failure(null, 'SIGTERM', acc)).toBeNull()
  })

  it.each([0, 1])('accepts normal exit %i without inventing truncation', (code) => {
    const acc = createAccumulator()
    expect(new RipgrepSearchDiagnostics().failure(code, null, acc)).toBeNull()
    expect(acc.truncated).toBe(false)
  })
})
