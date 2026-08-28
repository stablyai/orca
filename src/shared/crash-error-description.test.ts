import { describe, expect, it } from 'vitest'
import { describeCrashError } from './crash-error-description'

describe('describeCrashError', () => {
  it('does not throw when a non-Error value cannot be converted to a string', () => {
    const hostile = {
      [Symbol.toPrimitive](): never {
        throw new Error('conversion failed')
      }
    }

    expect(() => describeCrashError(hostile)).not.toThrow()
    expect(describeCrashError(hostile)).toMatchObject({
      errorName: 'NonErrorThrown',
      errorMessage: '[unprintable thrown value]'
    })
  })

  it('normalizes malformed Error fields before sanitizing them', () => {
    const error = new Error('fallback')
    Object.defineProperties(error, {
      message: { value: Symbol('message') },
      name: { value: 42 },
      stack: {
        get() {
          return {
            toString(): never {
              throw new Error('conversion failed')
            }
          }
        }
      }
    })

    expect(describeCrashError(error)).toMatchObject({
      errorName: '42',
      errorMessage: 'Symbol(message)'
    })
    expect(describeCrashError(error)).not.toHaveProperty('errorStack')
  })

  it('retains sanitized messages and the full sanitized stack alongside a fingerprint', () => {
    const error = new Error(
      [
        'Failed to render prompt: SECRET_TOKEN=first-secret',
        'Details in /Users/example/private-repo/first.ts token=second-secret',
        'Credentials alice:super-secret@example.com and /tmp/second-secret secret=third-secret'
      ].join('\n')
    )
    error.stack = [
      'Error: Failed to render prompt: SECRET_TOKEN=first-secret',
      'Details in /Users/example/private-repo/first.ts token=second-secret',
      'Credentials alice:super-secret@example.com and /tmp/second-secret secret=third-secret',
      '    at private message-shaped frame',
      '    at PrivateScreen (/Users/example/private-repo/screen.tsx:1:1)'
    ].join('\n')
    const description = describeCrashError(
      error,
      '\n    at PrivateScreen (/Users/example/private-repo/screen.tsx:1:1)'
    )

    expect(description.errorName).toBe('Error')
    expect(description.errorMessage).toContain('SECRET_TOKEN=[redacted]')
    expect(description.errorMessage).toContain('Details in [redacted-path] token=[redacted]')
    expect(description.errorMessage).toContain(
      'Credentials [redacted-credential]@example.com and [redacted-path] secret=[redacted]'
    )
    for (const privateValue of [
      'first-secret',
      '/Users/example/private-repo/first.ts',
      'second-secret',
      'alice:super-secret@',
      '/tmp/second-secret',
      'third-secret'
    ]) {
      expect(description.errorMessage).not.toContain(privateValue)
    }
    expect(description.errorFingerprint).toMatch(/^[0-9a-f]{8}$/)
    expect(description.errorStack).toContain(
      'Error: Failed to render prompt: SECRET_TOKEN=[redacted]'
    )
    expect(description.errorStack).toContain('at private message-shaped frame')
    expect(description.errorStack).toContain('at PrivateScreen ([redacted-path]')
    expect(description.componentStack).toContain('at PrivateScreen ([redacted-path]')
  })

  it('fingerprints the sanitized message and retains the desktop stack budget', () => {
    const first = new Error('secret=first-private-value')
    const second = new Error('secret=second-private-value')
    first.stack = 'x'.repeat(4_500)

    const firstDescription = describeCrashError(first)
    const secondDescription = describeCrashError(second)

    expect(firstDescription.errorMessage).toBe('secret=[redacted]')
    expect(secondDescription.errorMessage).toBe(firstDescription.errorMessage)
    expect(secondDescription.errorFingerprint).toBe(firstDescription.errorFingerprint)
    expect(firstDescription.errorStack).toBe(`${'x'.repeat(4_000)}...`)
  })
})
