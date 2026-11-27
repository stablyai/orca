import { expect, it } from 'vitest'
import { browserCreateErrorForLog } from './web-runtime-browser-create-failure-code'

it("a user link's failed navigation logs its code, never the URL in the host's message", () => {
  const hostError = Object.assign(
    new Error('ERR_NAME_NOT_RESOLVED loading https://example.com/?token=fixture-secret'),
    { code: 'browser_error' }
  )
  expect(browserCreateErrorForLog('operation-only', hostError)).toBe('browser_error')
  expect(browserCreateErrorForLog('operation-only', new Error('https://example.com/'))).toBe(
    'no code'
  )
})
