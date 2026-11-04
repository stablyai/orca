import { afterEach, describe, expect, it, vi } from 'vitest'
import * as sanitation from '../../../shared/check-job-log-excerpt'
import * as ansi from '../../../shared/ansi-escape-sequences'
import * as ownership from '../../../shared/own-retained-string'
import { normalizeCheckRunDetailsLogTails } from './check-run-details-log-normalization'
import {
  checkLogDetails,
  checkLogJob,
  expectedLegacyControls,
  mixedCheckLogDetails
} from './check-run-details-log-normalization-test-fixture'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  ownership.resetOwnRetainedStringCopier()
})

describe('check details log ingress normalization', () => {
  it('preserves frozen metadata, references, order, optional outcomes and unknown omission', () => {
    const raw = mixedCheckLogDetails()
    const snapshot = JSON.stringify(raw)
    const sanitize = vi.spyOn(sanitation, 'sanitizeCheckJobLogExcerpt')
    const result = normalizeCheckRunDetailsLogTails(raw)
    if (!result) {
      throw new Error('Expected details')
    }
    expect(result).not.toBe(raw)
    expect(result.jobs).not.toBe(raw.jobs)
    expect(result.annotations).toBe(raw.annotations)
    expect(result.jobs.map((job) => job.id)).toEqual(raw.jobs.map((job) => job.id))
    expect(result.jobs.map((job) => job.logState)).toEqual([
      undefined,
      'available',
      'empty',
      'error',
      'not_requested',
      undefined
    ])
    expect(Object.hasOwn(result.jobs[0], 'logState')).toBe(false)
    expect(Object.hasOwn(result.jobs[5], 'logState')).toBe(false)
    expect(result.jobs[0].logTail).toBe(expectedLegacyControls)
    expect(result.jobs[3].logTail).toBe('contradictory error tail')
    expect(result.jobs[2].logTail).toBe('')
    for (const [i, job] of result.jobs.entries()) {
      expect(job.steps).toBe(raw.jobs[i].steps)
      expect({ ...job, logTail: raw.jobs[i].logTail }).toEqual(raw.jobs[i])
      expect(job === raw.jobs[i]).toBe(raw.jobs[i].logTail === null)
    }
    expect({ ...result, jobs: raw.jobs }).toEqual(raw)
    expect(sanitize.mock.calls.map(([tail]) => tail)).toEqual(
      raw.jobs.flatMap((job) => (typeof job.logTail === 'string' ? [job.logTail] : []))
    )
    expect(JSON.stringify(raw)).toBe(snapshot)
    expect(normalizeCheckRunDetailsLogTails(result)).toEqual(result)
  })

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
