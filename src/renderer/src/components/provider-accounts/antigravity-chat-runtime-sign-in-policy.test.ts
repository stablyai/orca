import { expect, it } from 'vitest'
import type {
  ManagedRuntimeInstallState,
  ManagedRuntimeOperation
} from '../../../../shared/agent-launch/installation/managed-runtime-install'
import {
  antigravityOrcaRuntimeSignsIn,
  antigravityProviderSignInShown
} from './antigravity-chat-runtime-sign-in-policy'

function server(
  installedVersion: string | null,
  operation: Partial<ManagedRuntimeOperation> | null
) {
  const state: ManagedRuntimeInstallState = {
    agent: 'antigravity',
    program: 'server',
    revision: 1,
    available: true,
    version: '1.5.2',
    installedVersion,
    installedCurrent: false,
    source: installedVersion === null ? null : 'managed',
    operation: operation && {
      id: 'op',
      kind: 'install',
      phase: 'downloading',
      downloadedBytes: 0,
      totalBytes: 100,
      ...operation
    }
  }
  return {
    kind: 'active' as const,
    subject: { target: { kind: 'local' as const }, runtimeId: null, agent: 'antigravity' },
    snapshot: { kind: 'known' as const, state },
    removable: true
  }
}

it('keeps the sign-in of a server that is being updated, which chats keep running', () => {
  for (const phase of ['downloading', 'extracting', 'verifying'] as const) {
    expect(antigravityProviderSignInShown(server('1.5.0', { phase }))).toBe(true)
    expect(antigravityOrcaRuntimeSignsIn(server('1.5.0', { phase }))).toBe(true)
  }
})

it('hides it during a first install or a removal', () => {
  expect(antigravityProviderSignInShown(server(null, { phase: 'downloading' }))).toBe(false)
  expect(
    antigravityProviderSignInShown(server('1.5.0', { kind: 'remove', phase: 'removing' }))
  ).toBe(false)
})
