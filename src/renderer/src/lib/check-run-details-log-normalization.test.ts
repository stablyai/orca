import { afterEach, describe, expect, it, vi } from 'vitest'
import * as ansi from '../../../shared/ansi-escape-sequences'
import * as ownership from '../../../shared/own-retained-string'
import { normalizeCheckRunDetailsLogTails } from './check-run-details-log-normalization'
import { checkLogDetails, checkLogJob } from './check-run-details-log-normalization-test-fixture'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  ownership.resetOwnRetainedStringCopier()
})

describe('check details log ingress normalization', () => {
  it('uses the real no-Buffer owned copier and does not split multibyte boundaries', () => {
    vi.stubGlobal('Buffer', undefined)
    ownership.resetOwnRetainedStringCopier()
    const strip = vi.spyOn(ansi, 'stripAnsiEscapeSequences')
    const raw = `${'漢😀'.repeat(300_000)}\r\nLAST\t😀漢\r`
    const result = normalizeCheckRunDetailsLogTails(checkLogDetails([checkLogJob(raw)]))
    const tail = result?.jobs[0].logTail
    expect(tail).toMatch(/\nLAST\t😀漢\n$/)
    expect(tail).not.toMatch(
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u
    )
    expect(strip).toHaveBeenCalledOnce()
    expect(new TextEncoder().encode(strip.mock.calls[0][0]).length).toBeLessThanOrEqual(16_384)
    expect(new TextEncoder().encode(tail ?? '').length).toBeLessThanOrEqual(16_384)
  })
})
