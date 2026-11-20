import { describe, expect, it } from 'vitest'
import type { ManagedRuntimeProgram } from '../../../../shared/agent-launch/installation/managed-runtime-install'
import {
  antigravityChatDescription,
  antigravityChatSignInBlocked,
  antigravityOrcaRuntimeSignsIn,
  antigravityProviderSignInShown
} from './antigravity-chat-runtime-sign-in-policy'

function installed(program?: ManagedRuntimeProgram, source: 'managed' | null = 'managed') {
  return {
    kind: 'active' as const,
    subject: { target: { kind: 'local' as const }, runtimeId: null, agent: 'antigravity' },
    removable: true,
    snapshot: {
      kind: 'known' as const,
      state: {
        agent: 'antigravity',
        ...(program && { program }),
        revision: 1,
        available: true,
        version: '1.5.13',
        installedVersion: source && '1.5.13',
        installedCurrent: source !== null,
        source,
        operation: null
      }
    }
  }
}

describe("Orca's Antigravity sign-in", () => {
  it.each([
    ['an older host’s server', undefined],
    ['Orca’s server', 'server' as const]
  ])('applies to %s', (_case, program) => {
    const install = installed(program)

    expect(antigravityProviderSignInShown(install)).toBe(true)
    expect(antigravityChatSignInBlocked(install)).toBe(false)
    expect(antigravityOrcaRuntimeSignsIn(install)).toBe(true)
  })

  it("stays away from Orca's copy of agy, which signs itself in", () => {
    const install = installed('cli')

    expect(antigravityProviderSignInShown(install)).toBe(false)
    expect(antigravityChatSignInBlocked(install)).toBe(true)
    expect(antigravityOrcaRuntimeSignsIn(install)).toBe(false)
  })
})

it.each([
  ["Orca's copy of agy", installed('cli'), 'orcasAgy'],
  ['agy before it is installed', installed('cli', null), 'installAgy'],
  ["Orca's server", installed('server'), 'orcaSignIn']
] as const)('the Chat section says new chats run on %s', (_case, install, expected) => {
  expect(antigravityChatDescription({ chatUsesAgy: false }, install)).toBe(expected)
})
