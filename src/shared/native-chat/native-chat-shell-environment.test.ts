import { describe, expect, it } from 'vitest'
import {
  isNativeChatShellEnvironmentName,
  nativeChatShellEnvironmentPolicy
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
  it('carries the listed names, re-validated, when inheritance is off', () => {
    expect(
      nativeChatShellEnvironmentPolicy({
        nativeChatInheritShellEnvironment: false,
        nativeChatShellEnvironmentVariables: ['CODEX_LB_API_KEY', 'not valid', 'CODEX_LB_API_KEY']
      })
    ).toEqual({ inheritAll: false, names: ['CODEX_LB_API_KEY'] })
  })
})
