import { describe, expect, it } from 'vitest'
import {
  BROWSER_CLIENT_AUTOMATION_PARAMS_MAX_BYTES,
  BROWSER_CLIENT_AUTOMATION_RESULT_MAX_BYTES,
  BrowserClientAutomationCommand,
  BrowserClientAutomationResult
} from './browser-client-automation-protocol'

describe('browser client automation protocol', () => {
  it('accepts one targeted browser RPC envelope and bounded result', () => {
    expect(
      BrowserClientAutomationCommand.parse({
        type: 'automation',
        method: 'browser.click',
        params: { element: 'Submit' }
      })
    ).toEqual({ type: 'automation', method: 'browser.click', params: { element: 'Submit' } })
    expect(
      BrowserClientAutomationResult.parse({
        status: 'completed',
        value: { clicked: true }
      })
    ).toEqual({ status: 'completed', value: { clicked: true } })
  })

  it('rejects lifecycle/global methods and oversized JSON on both directions', () => {
    for (const method of [
      'browser.tabCreate',
      'browser.tabClose',
      'browser.profileImportFromBrowser',
      'browser.screencast'
    ]) {
      expect(() =>
        BrowserClientAutomationCommand.parse({ type: 'automation', method, params: {} })
      ).toThrow()
    }
    expect(() =>
      BrowserClientAutomationCommand.parse({
        type: 'automation',
        method: 'browser.eval',
        params: { expression: 'x'.repeat(BROWSER_CLIENT_AUTOMATION_PARAMS_MAX_BYTES) }
      })
    ).toThrow('Browser client automation params exceed their byte budget')
    expect(() =>
      BrowserClientAutomationResult.parse({
        status: 'completed',
        value: 'x'.repeat(BROWSER_CLIENT_AUTOMATION_RESULT_MAX_BYTES)
      })
    ).toThrow('Browser client automation result exceeds its byte budget')
  })
})
