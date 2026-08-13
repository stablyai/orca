import { describe, expect, it } from 'vitest'
import {
  addLegacyTerminalAttributionDisableRequest,
  hostSupportsSessionTabTerminalCreateAttributionDisable,
  hostSupportsTerminalCreateAttributionDisable,
  hostSupportsTerminalSplitAttributionDisable,
  LEGACY_TERMINAL_ATTRIBUTION_BYPASS_ENV_KEY,
  LEGACY_TERMINAL_ATTRIBUTION_ENABLE_ENV_KEY,
  withLegacyTerminalAttributionDisabledEnv
} from './legacy-terminal-attribution-env'

describe('legacy terminal attribution environment', () => {
  it('adds the inert old-host gate once', () => {
    expect(addLegacyTerminalAttributionDisableRequest(['CODEX_HOME'])).toEqual([
      'CODEX_HOME',
      LEGACY_TERMINAL_ATTRIBUTION_ENABLE_ENV_KEY
    ])
    expect(
      addLegacyTerminalAttributionDisableRequest([LEGACY_TERMINAL_ATTRIBUTION_ENABLE_ENV_KEY])
    ).toEqual([LEGACY_TERMINAL_ATTRIBUTION_ENABLE_ENV_KEY])
  })

  it('fails instead of dropping a caller deletion at the wire limit', () => {
    const full = Array.from({ length: 32 }, (_, index) => `KEY_${index}`)
    expect(() => addLegacyTerminalAttributionDisableRequest(full)).toThrow(
      'Terminal environment deletion limit'
    )
  })

  it('adds the wrapper bypass without mutating caller env', () => {
    const env = { CODEX_HOME: '/tmp/codex' }
    expect(withLegacyTerminalAttributionDisabledEnv(env)).toEqual({
      CODEX_HOME: '/tmp/codex',
      [LEGACY_TERMINAL_ATTRIBUTION_BYPASS_ENV_KEY]: '1'
    })
    expect(env).toEqual({ CODEX_HOME: '/tmp/codex' })
  })

  it('accepts only split hosts that removed attribution for every pane owner', () => {
    expect(hostSupportsTerminalSplitAttributionDisable({ appVersion: '1.4.18' })).toBe(false)
    expect(hostSupportsTerminalSplitAttributionDisable({ appVersion: '1.4.19' })).toBe(false)
    expect(hostSupportsTerminalSplitAttributionDisable({ appVersion: 'v1.4.181' })).toBe(false)
    expect(hostSupportsTerminalSplitAttributionDisable({ capabilities: ['mobile.tasks.v1'] })).toBe(
      false
    )
    expect(
      hostSupportsTerminalSplitAttributionDisable({
        capabilities: ['terminal.attribution-removed.v1']
      })
    ).toBe(true)
  })

  it('accepts only capability-proven terminal creation hosts', () => {
    expect(hostSupportsSessionTabTerminalCreateAttributionDisable({ appVersion: '1.4.89' })).toBe(
      false
    )
    expect(hostSupportsSessionTabTerminalCreateAttributionDisable({ appVersion: '1.4.90' })).toBe(
      false
    )
    expect(
      hostSupportsSessionTabTerminalCreateAttributionDisable({ appVersion: 'not-semver' })
    ).toBe(false)
    expect(
      hostSupportsSessionTabTerminalCreateAttributionDisable({
        capabilities: ['workspace-run-context.v1']
      })
    ).toBe(false)
    expect(
      hostSupportsSessionTabTerminalCreateAttributionDisable({
        capabilities: ['terminal.quick-commands.v1']
      })
    ).toBe(false)
  })

  it('accepts capability-proven current hosts regardless of development version', () => {
    const status = {
      appVersion: '0.0.0-dev',
      capabilities: ['terminal.attribution-removed.v1']
    }
    expect(hostSupportsTerminalSplitAttributionDisable(status)).toBe(true)
    expect(hostSupportsTerminalCreateAttributionDisable(status)).toBe(true)
    expect(hostSupportsSessionTabTerminalCreateAttributionDisable(status)).toBe(true)
  })

  it('fails closed for malformed host status fields', () => {
    expect(
      hostSupportsSessionTabTerminalCreateAttributionDisable({
        appVersion: 1.49,
        capabilities: 'terminal.attribution-removed.v1'
      })
    ).toBe(false)
    expect(
      hostSupportsTerminalSplitAttributionDisable({
        appVersion: {},
        capabilities: ['terminal.attribution-removed.v1', 1]
      })
    ).toBe(false)
  })
})
