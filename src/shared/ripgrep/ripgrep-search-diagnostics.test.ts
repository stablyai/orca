import { describe, expect, it } from 'vitest'
import { createAccumulator } from '../file-search/text-search'
import { RipgrepSearchDiagnostics } from './ripgrep-search-diagnostics'

describe('ripgrep search diagnostics', () => {
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

  describe('skippable per-path OS errors', () => {
    const skippable = new Set([1, 1920])

    it('does not fail or truncate a search whose only errors are unopenable paths', () => {
      const diagnostics = new RipgrepSearchDiagnostics(skippable)
      diagnostics.append('rg: .\\nul: Incorrect function. (os error 1)\r\nrg: .\\li')
      diagnostics.append('nk: The file cannot be accessed by the system. (os error 1920)')
      const acc = createAccumulator()
      acc.totalMatches = 3
      expect(diagnostics.failure(2, null, acc)).toBeNull()
      expect(acc.truncated).toBe(false)
      expect(diagnostics.failure(2, null, createAccumulator())).toBeNull()
    })

    it('still fails on any other diagnostic', () => {
      const diagnostics = new RipgrepSearchDiagnostics(skippable)
      diagnostics.append('rg: .\\nul: Incorrect function. (os error 1)\n')
      diagnostics.append('rg: ./secret: Access is denied. (os error 5)\n')
      expect(diagnostics.failure(2, null, createAccumulator())).toBeInstanceOf(Error)
    })
  })
})
