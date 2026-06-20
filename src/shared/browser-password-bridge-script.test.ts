// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildBrowserPasswordBridgeScript,
  buildBrowserPasswordFillCall
} from './browser-password-bridge-script'
import { BROWSER_PASSWORD_MESSAGE_PREFIX } from './browser-credential-types'

const TOKEN = 'tok_aaaaaaaaaaaaaaaa'

function runBridge(): void {
  // eslint-disable-next-line no-eval
  ;(0, eval)(buildBrowserPasswordBridgeScript({ token: TOKEN, enabled: true }))
}

beforeEach(() => {
  document.body.innerHTML = `
    <form>
      <input type="text" name="user" />
      <input type="password" name="pass" />
      <button type="submit">Go</button>
    </form>`
})
afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('buildBrowserPasswordBridgeScript', () => {
  it('emits a detect event tagging the username field', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    runBridge()
    const detect = debug.mock.calls
      .map(([m]) => String(m))
      .find((m) => m.startsWith(`${BROWSER_PASSWORD_MESSAGE_PREFIX}${TOKEN}:`))
    expect(detect).toBeTruthy()
    const payload = JSON.parse(detect!.slice(`${BROWSER_PASSWORD_MESSAGE_PREFIX}${TOKEN}:`.length))
    expect(payload.type).toBe('detect')
    expect(payload.fields).toHaveLength(1)
    expect(document.querySelector('[data-orca-pwid]')).not.toBeNull()
  })

  it('emits a capture event on form submit', () => {
    runBridge()
    ;(document.querySelector('input[name="user"]') as HTMLInputElement).value = 'me'
    ;(document.querySelector('input[name="pass"]') as HTMLInputElement).value = 'pw'
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    document
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
    const capture = debug.mock.calls
      .map(([m]) => String(m))
      .map((m) => m.slice(`${BROWSER_PASSWORD_MESSAGE_PREFIX}${TOKEN}:`.length))
      .map((s) => {
        try {
          return JSON.parse(s)
        } catch {
          return null
        }
      })
      .find((p) => p?.type === 'capture')
    expect(capture).toMatchObject({ type: 'capture', username: 'me', password: 'pw' })
  })

  it('fill() sets values and dispatches input/change', () => {
    runBridge()
    const fieldId = document.querySelector('[data-orca-pwid]')!.getAttribute('data-orca-pwid')!
    const pass = document.querySelector('input[name="pass"]') as HTMLInputElement
    const changed = vi.fn()
    pass.addEventListener('input', changed)
    // eslint-disable-next-line no-eval
    ;(0, eval)(buildBrowserPasswordFillCall(fieldId, 'me', 'pw'))
    expect((document.querySelector('input[name="user"]') as HTMLInputElement).value).toBe('me')
    expect(pass.value).toBe('pw')
    expect(changed).toHaveBeenCalled()
  })
})
