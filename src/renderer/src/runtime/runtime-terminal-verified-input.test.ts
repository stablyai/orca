import { z } from 'zod'
import { OptionalString, requiredString } from '../../../shared/rpc-contract/rpc-param-primitives'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sendRuntimePtyInputVerified } from './runtime-terminal-verified-input'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from './runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'

const REMOTE_PTY = 'remote:env-1@@terminal-1'
const runtimeSend = vi.fn()
const localWrite = vi.fn()
const localWriteAccepted = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  vi.clearAllMocks()
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        call: (args: RuntimeEnvironmentCallRequest) =>
          createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeSend(args)
      },
      pty: { write: localWrite, writeAccepted: localWriteAccepted }
    }
  })
})

function hostReply(send: Record<string, unknown>) {
  runtimeSend.mockResolvedValue({
    ok: true,
    result: { send: { handle: 'terminal-1', bytesWritten: 1, ...send } },
    _meta: { runtimeId: 'runtime-1' }
  })
}

describe('verified input that requires provider settlement', () => {
  it.each([
    ['older host whole-write', { accepted: true }, true],
    ['acknowledged', { accepted: true, writeSettlement: { outcome: 'accepted' } }, true],
    [
      'refused',
      { accepted: false, writeSettlement: { outcome: 'refused', reason: 'endpoint_disconnected' } },
      false
    ]
  ] as const)('reads the %s remote verdict', async (_label, send, accepted) => {
    hostReply(send)
    await expect(
      sendRuntimePtyInputVerified(REMOTE_PTY, 'x', 'driving', {
        requireWriteSettlement: true
      })
    ).resolves.toBe(accepted)
    expect(runtimeSend).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.send',
        params: expect.objectContaining({ requireWriteSettlement: true })
      })
    )
  })

  it('rejects a remote send whose settlement is unverifiable, without a fallback write', async () => {
    hostReply({
      accepted: false,
      writeSettlement: {
        outcome: 'unverifiable',
        reason: 'transport_settlement_lost',
        bytesHandedToTransport: true
      }
    })
    await expect(
      sendRuntimePtyInputVerified(REMOTE_PTY, 'x', 'driving', {
        requireWriteSettlement: true
      })
    ).rejects.toThrow('acknowledgment unavailable')
    expect(localWrite).not.toHaveBeenCalled()
    expect(runtimeSend).toHaveBeenCalledOnce()
  })
})

describe('local verified input', () => {
  it('keeps the fire-and-forget fallback for ordinary input the provider cannot accept', async () => {
    localWriteAccepted.mockResolvedValue(false)
    await expect(sendRuntimePtyInputVerified('ssh:conn-1@@pty-1', 'x', 'driving')).resolves.toBe(
      true
    )
    expect(localWriteAccepted).toHaveBeenCalledWith('ssh:conn-1@@pty-1', 'x', 'driving')
    expect(localWrite).toHaveBeenCalledWith('ssh:conn-1@@pty-1', 'x', 'driving')
  })

  it('never falls back to an unacknowledged write when settlement is required', async () => {
    const settled = { requireWriteSettlement: true } as const
    localWriteAccepted.mockResolvedValueOnce(true)
    await expect(
      sendRuntimePtyInputVerified('ssh:conn-1@@pty-1', 'answer', 'driving', settled)
    ).resolves.toBe(true)
    localWriteAccepted.mockResolvedValueOnce(false)
    await expect(
      sendRuntimePtyInputVerified('ssh:conn-1@@pty-1', '1', 'driving', settled)
    ).resolves.toBe(false)
    localWriteAccepted.mockRejectedValueOnce(new Error('acknowledgment unavailable'))
    await expect(
      sendRuntimePtyInputVerified('ssh:conn-1@@pty-1', '\r', 'driving', settled)
    ).rejects.toThrow('acknowledgment unavailable')
    expect(localWriteAccepted).toHaveBeenCalledWith('ssh:conn-1@@pty-1', '\r', 'driving', settled)
    expect(localWrite).not.toHaveBeenCalled()
  })
})

describe('owner of the PTY', () => {
  it('never dials a server for a remote id that names no owner', async () => {
    localWriteAccepted.mockResolvedValue(false)
    // Why: this id used to reach whichever server was focused, even when another one owned it.
    await sendRuntimePtyInputVerified('remote:terminal-1', 'x', 'driving', {
      requireWriteSettlement: true
    })
    expect(runtimeSend).not.toHaveBeenCalled()
  })

  it('sends to the server the id names', async () => {
    hostReply({ accepted: true })
    await sendRuntimePtyInputVerified(REMOTE_PTY, 'x', 'driving')
    expect(runtimeSend).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-1', method: 'terminal.send' })
    )
  })
})

// Frozen terminal.send schema from e04f4dc8a9ecf2da598e9393e46cbfb28bfe4d6d.
const legacyTerminalSend = z.object({
  terminal: requiredString('Missing terminal handle'),
  expectedIncarnationId: requiredString('Missing PTY incarnation').optional(),
  text: OptionalString,
  enter: z.unknown().optional(),
  interrupt: z.unknown().optional(),
  agentPrompt: z.literal(true).optional(),
  requireWriteSettlement: z.literal(true).optional(),
  waitSubmitMs: z.number().int().min(0).max(3_600_000).optional(),
  resolvedLaunchDraft: z
    .object({
      text: z.string(),
      createdAt: z.number().finite()
    })
    .optional(),
  requireAgentStatus: z.enum(['sendable']).optional(),
  inputKind: z.enum(['query-reply']).optional(),
  client: z
    .object({
      id: requiredString('Missing client ID'),
      type: z.enum(['mobile', 'desktop']).default('desktop').optional()
    })
    .optional(),
  viewport: z
    .object({
      cols: z.number().int().min(1).max(1000),
      rows: z.number().int().min(1).max(500)
    })
    .optional(),
  claimViewport: z.literal(true).optional()
})

describe('tagged Stop keeps one legacy delivery', () => {
  it.each([false, true])(
    'does not resend a local/SSH Stop after ordinary verdict %s',
    async (accepted) => {
      localWriteAccepted.mockResolvedValue(accepted)
      await expect(
        sendRuntimePtyInputVerified('ssh:conn-1@@pty-1', '\x1b', 'driving', {
          chatStop: { id: 'stop', index: 1 }
        })
      ).resolves.toBe(accepted)
      expect(localWriteAccepted).toHaveBeenCalledOnce()
      expect(localWrite).not.toHaveBeenCalled()
    }
  )
  it('does not resend after a provider throws after handoff', async () => {
    localWriteAccepted.mockRejectedValue(new Error('lost reply'))
    await expect(
      sendRuntimePtyInputVerified('pty-1', '\x1b', 'driving', {
        chatStop: { id: 'stop', index: 1 }
      })
    ).rejects.toThrow('lost reply')
    expect(localWrite).not.toHaveBeenCalled()
  })
  it('lets a frozen older paired host strip only metadata and return the original reply', async () => {
    runtimeSend.mockImplementation(async (request) => {
      expect(legacyTerminalSend.parse(request.params)).toEqual({
        terminal: 'terminal-1',
        text: '\x1b',
        client: { id: 'orca-desktop', type: 'desktop' }
      })
      return {
        ok: true,
        result: { send: { handle: 'terminal-1', accepted: true, bytesWritten: 1 } },
        _meta: { runtimeId: 'runtime-1' }
      }
    })
    await expect(
      sendRuntimePtyInputVerified(REMOTE_PTY, '\x1b', 'driving', {
        chatStop: { id: 'stop', index: 1 }
      })
    ).resolves.toBe(true)
    expect(runtimeSend).toHaveBeenCalledOnce()
    expect(localWrite).not.toHaveBeenCalled()
  })
})
