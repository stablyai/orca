import { describe, expect, it } from 'vitest'
import type { ManagedRuntimeInstallObservation } from '@/runtime/hosts/installation/use-managed-runtime-install'
import type { ManagedRuntimeInstallState } from '../../../../shared/agent-launch/installation/managed-runtime-install'
import type { AntigravityChatAuthConfig } from '../../../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { antigravityChatDescription } from './antigravity-chat-description'

const install = (state: Partial<ManagedRuntimeInstallState>): ManagedRuntimeInstallObservation => ({
  kind: 'active',
  removable: true,
  subject: { target: { kind: 'local' }, runtimeId: null, agent: 'antigravity' },
  snapshot: {
    kind: 'known',
    state: {
      agent: 'antigravity',
      program: 'cli',
      revision: 1,
      available: true,
      version: '1.5.13',
      installedVersion: '1.5.13',
      installedCurrent: true,
      updatesAutomatically: true,
      source: 'managed',
      operation: null,
      ...state
    }
  }
})

describe('what Settings says about Antigravity chats', () => {
  it.each<
    [
      string,
      Partial<ManagedRuntimeInstallState>,
      AntigravityChatAuthConfig['method'] | null,
      string
    ]
  >([
    ['an older host still on the server', { program: 'server' }, null, 'olderHost'],
    ['no agy yet, even with a key saved', { source: null }, 'gemini-api-key', 'installAgy'],
    ["Orca's agy switched off", { updatesAutomatically: undefined }, null, 'orcasAgyOff'],
    ['a key or gcloud saved', {}, 'agent-platform', 'orcaHome'],
    ["Orca's agy with Google", {}, 'oauth-personal', 'orcasAgy'],
    ['your own agy', { source: 'external' }, 'oauth-personal', 'agy']
  ])('%s', (_case, state, method, expected) => {
    expect(antigravityChatDescription(null, install(state), method)).toBe(expected)
  })

  it('warns that agy is signed out when chats use its login', () => {
    expect(antigravityChatDescription({ chatAgySignedOut: true }, install({}), null)).toBe(
      'agySignedOut'
    )
  })
})
