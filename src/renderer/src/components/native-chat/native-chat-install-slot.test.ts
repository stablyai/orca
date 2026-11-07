import { expect, it } from 'vitest'
import { nativeChatInstallSlotState } from './NativeChatInstallSlot'

it("offers Orca's install only to chats that run the managed runtime", () => {
  const notInstalled = {
    kind: 'active' as const,
    subject: { target: { kind: 'local' as const }, runtimeId: null, agent: 'antigravity' },
    removable: false,
    snapshot: {
      kind: 'known' as const,
      state: {
        agent: 'antigravity',
        revision: 1,
        available: true,
        version: '1.4.1',
        installedVersion: null,
        installedCurrent: false,
        source: null,
        operation: null
      }
    }
  }
  expect(nativeChatInstallSlotState(notInstalled, 'strip', false).kind).toBe('install')
  expect(nativeChatInstallSlotState(notInstalled, 'strip', true)).toEqual({ kind: 'none' })
})
