import { describe, expect, it } from 'vitest'
import {
  isNativeChatShellEnvironmentName,
  nativeChatShellEnvironmentPolicy,
  normalizeNativeChatShellEnvironmentVariables
} from './native-chat-shell-environment'

describe('isNativeChatShellEnvironmentName', () => {
  it('accepts a whole shell variable name and nothing else', () => {
    for (const name of ['CODEX_LB_API_KEY', 'https_proxy', '_OK', 'A1']) {
      expect(isNativeChatShellEnvironmentName(name), name).toBe(true)
    }
    for (const name of ['', ' ', 'FOO-BAR', '1BAD', 'FOO BAR', 'FOO,BAR', 'HTTPS_PROXY ']) {
      expect(isNativeChatShellEnvironmentName(name), JSON.stringify(name)).toBe(false)
    }
  })
})

describe('nativeChatShellEnvironmentPolicy', () => {
  it('inherits the whole shell when the setting is absent', () => {
    expect(nativeChatShellEnvironmentPolicy(null)).toEqual({ inheritAll: true, names: [] })
    expect(nativeChatShellEnvironmentPolicy({})).toEqual({ inheritAll: true, names: [] })
  })

  it('carries the listed names, re-validated, when inheritance is off', () => {
    expect(
      nativeChatShellEnvironmentPolicy({
        nativeChatInheritShellEnvironment: false,
        nativeChatShellEnvironmentVariables: ['CODEX_LB_API_KEY', 'not valid', 'CODEX_LB_API_KEY']
      })
    ).toEqual({ inheritAll: false, names: ['CODEX_LB_API_KEY'] })
  })
})

describe('normalizeNativeChatShellEnvironmentVariables', () => {
  it('returns an empty list for anything that is not an array', () => {
    expect(normalizeNativeChatShellEnvironmentVariables(undefined)).toEqual([])
    expect(normalizeNativeChatShellEnvironmentVariables('HTTPS_PROXY')).toEqual([])
    expect(normalizeNativeChatShellEnvironmentVariables({ 0: 'HTTPS_PROXY' })).toEqual([])
  })

  it('keeps only valid string names, once each', () => {
    expect(
      normalizeNativeChatShellEnvironmentVariables(['HTTPS_PROXY', 7, 'not valid', 'HTTPS_PROXY'])
    ).toEqual(['HTTPS_PROXY'])
  })
})
