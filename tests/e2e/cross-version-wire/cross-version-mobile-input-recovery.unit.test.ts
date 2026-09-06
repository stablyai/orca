import { randomBytes } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { createStableLogicalRpcClient } from '../../../mobile/src/transport/stable-logical-rpc-client'
import {
  createOrderedInputPtyTestRig,
  inputProofDeadline
} from '../../../src/main/runtime/rpc/terminal-ordered-input-pty-test-rig'
import { loadMobileTerminalWireBuild } from './versioned-mobile-terminal-wire'
import { WORKING_TREE } from './versioned-terminal-wire'
import { openMobileInputWireSession } from './mobile-input-wire-session'

vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(randomBytes(length))
}))

// This scenario requires an actual pre-ordered-input host, unlike the rolling happy-path baseline.
const PRE_ORDERED_INPUT_HOST = 'v1.4.197'

it('fences uncertain input across a released-host downgrade until explicit compatible recovery', async () => {
  const [current, oldHost] = await Promise.all([
    loadMobileTerminalWireBuild(WORKING_TREE),
    loadMobileTerminalWireBuild(PRE_ORDERED_INPUT_HOST)
  ])
  const expected = Buffer.from('prefix한글fresh\r')
  const rig = await createOrderedInputPtyTestRig(expected)
  const sessions: Awaited<ReturnType<typeof openMobileInputWireSession>>[] = []
  let logical: ReturnType<typeof createStableLogicalRpcClient> | undefined
  const subscriptions: { capabilities?: { orderedInput?: unknown } }[] = []
  try {
    const initial = await openMobileInputWireSession(current, current, rig.runtime, {
      dropInputReceipts: true,
      connectionId: 'recovery-initial'
    })
    sessions.push(initial)
    logical = createStableLogicalRpcClient(initial.rpc, 'relay')
    logical.subscribe(
      'terminal.subscribe',
      {
        terminal: 'terminal-1',
        client: { id: 'phone', type: 'mobile' },
        capabilities: { terminalBinaryStream: 1 }
      },
      (event) => {
        const result = event as { type?: string; capabilities?: { orderedInput?: unknown } }
        if (result.type === 'subscribed') {
          subscriptions.push(result)
        }
      }
    )
    await vi.waitFor(() => expect(subscriptions).toHaveLength(1))
    expect(logical.supportsTerminalStreamInput?.('terminal-1')).toBe(true)
    const prefix = logical.sendTerminalStreamInput!('terminal-1', 'prefix한글')!
    await vi.waitFor(() => {
      expect(initial.counts().droppedReceipts).toBe(1)
      expect(rig.bytes()).toEqual(Buffer.from('prefix한글'))
    })
    logical.suspendActiveSession()
    expect(await inputProofDeadline(prefix, 'uncertain prefix settlement')).toBe(false)
    expect(logical.getTerminalStreamInputFailure?.('terminal-1')).toMatchObject({
      outcome: 'unknown'
    })

    const legacy = await openMobileInputWireSession(oldHost, current, rig.runtime, {
      connectionId: 'recovery-legacy'
    })
    sessions.push(legacy)
    const legacyJson = vi.spyOn(legacy.rpc, 'sendRequest')
    const legacyStream = vi.spyOn(legacy.rpc, 'sendTerminalStreamInput')
    await logical.migrateTo(legacy.rpc, 'relay')
    await vi.waitFor(() => expect(subscriptions).toHaveLength(2))
    expect(subscriptions[1]?.capabilities?.orderedInput, PRE_ORDERED_INPUT_HOST).toBeUndefined()
    expect(legacy.rpc.supportsTerminalStreamInput?.('terminal-1')).toBe(false)
    expect(logical.recoverTerminalStreamInput?.('terminal-1')).toBe(false)
    const enter = logical.sendTerminalStreamInput!('terminal-1', '\r')
    expect(enter).not.toBeNull()
    expect(await enter).toBe(false)
    await expect(
      logical.sendRequest('terminal.send', { terminal: 'terminal-1', text: '\r' })
    ).rejects.toThrow('Terminal input stopped')
    expect(legacyJson).not.toHaveBeenCalled()
    expect(legacyStream).not.toHaveBeenCalled()
    expect(legacy.counts()).toEqual({ binaryInputs: 0, jsonInputs: 0, droppedReceipts: 0 })

    const compatible = await openMobileInputWireSession(current, current, rig.runtime, {
      connectionId: 'recovery-compatible'
    })
    sessions.push(compatible)
    const compatibleStream = vi.spyOn(compatible.rpc, 'sendTerminalStreamInput')
    const compatibleJson = vi.spyOn(compatible.rpc, 'sendRequest')
    await logical.migrateTo(compatible.rpc, 'relay')
    await vi.waitFor(() => expect(subscriptions).toHaveLength(3))
    expect(compatible.rpc.supportsTerminalStreamInput?.('terminal-1')).toBe(true)
    expect(await logical.sendTerminalStreamInput!('terminal-1', '\r')).toBe(false)
    expect(compatible.counts().binaryInputs).toBe(0)
    expect(compatibleStream).not.toHaveBeenCalled()
    await expect(
      logical.sendRequest('terminal.send', { terminal: 'terminal-1', text: '\r' })
    ).rejects.toThrow('Terminal input stopped')
    expect(compatibleJson).not.toHaveBeenCalled()
    expect(logical.recoverTerminalStreamInput?.('terminal-1')).toBe(true)
    expect(
      await inputProofDeadline(
        logical.sendTerminalStreamInput!('terminal-1', 'fresh\r')!,
        'fresh receipt'
      )
    ).toBe(true)
    await inputProofDeadline(rig.inputDelivered, 'recovered PTY bytes')
    expect(rig.bytes()).toEqual(expected)
    expect(initial.counts()).toEqual({ binaryInputs: 1, jsonInputs: 0, droppedReceipts: 1 })
    expect(compatible.counts()).toEqual({ binaryInputs: 1, jsonInputs: 0, droppedReceipts: 0 })
    for (const session of sessions) {
      expect(session.errors).toEqual([])
    }
  } finally {
    try {
      logical?.close()
      const cleanup = await Promise.allSettled(sessions.map((session) => session.dispose()))
      expect(cleanup.filter((result) => result.status === 'rejected')).toEqual([])
    } finally {
      await rig.close()
    }
  }
}, 60_000)
