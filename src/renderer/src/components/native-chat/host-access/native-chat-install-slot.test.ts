import { describe, expect, it } from 'vitest'
import type { ManagedRuntimeProgram } from '../../../../../shared/agent-launch/installation/managed-runtime-install'
import { nativeChatInstallSlotState } from './NativeChatInstallSlot'

function route(program?: ManagedRuntimeProgram, source: 'managed' | null = null) {
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
        installedVersion: null,
        installedCurrent: false,
        source,
        operation: null
      }
    }
  }
}

describe('a chat on the host’s agy', () => {
  it('offers Orca’s agy Install while no agy is here', () => {
    expect(nativeChatInstallSlotState(route('cli'), 'strip', true).kind).toBe('install')
  })

  it.each([
    ['once Orca’s agy is installed', route('cli', 'managed')],
    ['where new chats install Orca’s server', route('server')],
    ['on an older host', route()]
  ])('offers nothing %s', (_case, observed) => {
    expect(nativeChatInstallSlotState(observed, 'strip', true).kind).toBe('none')
  })
})
