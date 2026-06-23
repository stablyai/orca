// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildBrowserPasswordBridgeScript,
  buildBrowserPasswordFillCall
} from './browser-password-bridge-script'
import { BROWSER_PASSWORD_MESSAGE_PREFIX } from './browser-credential-types'

const TOKEN = 'tok_aaaaaaaaaaaaaaaa'

function runBridge(enabled = true): void {
  // eslint-disable-next-line no-eval
  ;(0, eval)(buildBrowserPasswordBridgeScript({ token: TOKEN, enabled }))
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
  // Execute the DISABLE path first so document/window listeners and
  // MutationObserver from the prior runBridge() are properly torn down.
  runBridge(false)
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  // Clean up any residual globals after teardown.
  delete (globalThis as Record<string, unknown>).__orcaPasswordBridgeState
  delete (globalThis as Record<string, unknown>).__orcaPasswordBridge
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
    const inputSpy = vi.fn()
    const changeSpy = vi.fn()
    pass.addEventListener('input', inputSpy)
    pass.addEventListener('change', changeSpy)
    // eslint-disable-next-line no-eval
    ;(0, eval)(buildBrowserPasswordFillCall(fieldId, 'me', 'pw'))
    expect((document.querySelector('input[name="user"]') as HTMLInputElement).value).toBe('me')
    expect(pass.value).toBe('pw')
    expect(inputSpy).toHaveBeenCalled()
    expect(changeSpy).toHaveBeenCalled()
  })

  it('disable path tears down the bridge and removes the global', () => {
    runBridge()
    expect(globalThis.__orcaPasswordBridge).toBeDefined()
    runBridge(false)
    expect(globalThis.__orcaPasswordBridge).toBeUndefined()
  })

  it('teardown cancels a pending debounce so detect does not fire after disable', () => {
    vi.useFakeTimers()
    runBridge()
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    // Trigger a mutation-observer debounce by mutating the DOM.
    document.body.appendChild(document.createElement('div'))
    // Tear down before the 300 ms debounce fires.
    runBridge(false)
    vi.advanceTimersByTime(400)
    const afterDisable = debug.mock.calls
      .map(([m]) => String(m))
      .filter((m) => m.startsWith(`${BROWSER_PASSWORD_MESSAGE_PREFIX}${TOKEN}:`))
      .map((m) => {
        try {
          return JSON.parse(m.slice(`${BROWSER_PASSWORD_MESSAGE_PREFIX}${TOKEN}:`.length))
        } catch {
          return null
        }
      })
      .filter((p) => p?.type === 'detect')
    // No stale detect events should have fired after teardown.
    expect(afterDisable).toHaveLength(0)
    vi.useRealTimers()
  })

  it('fill() fallback escaping: crafted id with backslash and double-quote does not alter selector', () => {
    // Why: verifies the CSS.escape fallback escapes \ and " so a crafted
    // fieldId cannot break out of the double-quoted attribute selector.
    // We verify by running the escape logic extracted from the generated script.
    const script = buildBrowserPasswordBridgeScript({ token: TOKEN, enabled: true })
    // Extract the fallback branch from the generated script source text.
    // The fallback is: fieldId.split('\\').join('\\\\').split('"').join('\\"')
    // We run it directly with a crafted input.
    const escapeFn = new Function(
      'fieldId',
      // Pull the fallback expression out of the generated script's fill() body.
      `return ${script.match(/fieldId\.split\([^)]+\)\.join\([^)]+\)\.split\([^)]+\)\.join\([^)]+\)/)?.[0]};`
    )
    const crafted = 'pf-1\\"' // contains backslash and double-quote
    const esc = escapeFn(crafted)
    // The escaped value must not contain an unescaped " that would break the selector.
    // After escaping: backslash -> \\, double-quote -> \"
    expect(esc).toBe('pf-1\\\\\\"')
    // And a plain id is unchanged.
    expect(escapeFn('pf-42')).toBe('pf-42')
  })
})
