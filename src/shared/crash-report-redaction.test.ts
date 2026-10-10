import { describe, expect, it } from 'vitest'
import { sanitizeCrashReportString } from './crash-report-redaction'

/**
 * Why: a crash report leaves the machine. Each pattern below is the only thing standing between
 * a real secret or a real filesystem path and the report body, and neutering either of these two
 * used to leave the whole suite green.
 */

const API_KEY = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
const UNC_WITH_SPACE = 'open "\\\\fileserver\\Private Share\\brennan\\creds.txt" failed'

describe('sanitizeCrashReportString', () => {
  it('redacts a bare sk- API key that no assignment keyword introduces', () => {
    const sanitized = sanitizeCrashReportString(`Request failed for API key ${API_KEY} (401)`)

    expect(sanitized).not.toContain(API_KEY)
    expect(sanitized).not.toContain('sk-ant-api03')
    expect(sanitized).toContain('[redacted-secret]')
  })

  it('redacts a quoted UNC path whose segments contain spaces', () => {
    const sanitized = sanitizeCrashReportString(UNC_WITH_SPACE)

    expect(sanitized).not.toContain('Private Share')
    expect(sanitized).not.toContain('creds.txt')
    expect(sanitized).toContain('[redacted-path]')
  })

  // Positive control: prose that resembles neither must survive, so the assertions above
  // cannot pass by redacting everything.
  it('leaves text carrying no secret and no path untouched', () => {
    const prose = 'Renderer crashed while restoring 3 tabs after a sk- prefixed heading'

    expect(sanitizeCrashReportString(prose)).toBe(prose)
  })
})
