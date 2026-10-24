import { vi } from 'vitest'
import type { PtyTransport } from '../terminal-pane/pty-transport-types'

export function createExitReturnTransport(initialPtyId: string): PtyTransport {
  let ptyId: string | null = initialPtyId
  return {
    attach: vi.fn(({ existingPtyId }: { existingPtyId: string }) => {
      ptyId = existingPtyId
    }),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(() => {
      ptyId = null
    }),
    sendInput: vi.fn(() => true),
    sendInputImmediate: vi.fn(() => true),
    sendInputAccepted: vi.fn(async () => true),
    claimViewport: vi.fn(() => true),
    resize: vi.fn(() => true),
    isConnected: vi.fn(() => true),
    getPtyId: vi.fn(() => ptyId),
    getConnectionId: vi.fn(() => null)
  }
}
