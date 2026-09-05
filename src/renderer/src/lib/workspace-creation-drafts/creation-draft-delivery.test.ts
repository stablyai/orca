import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RUNTIME_CAPABILITIES,
  TERMINAL_SEND_INCARNATION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  ready: vi.fn(),
  capabilities: vi.fn(),
  web: false,
  state: {
    repos: [{ id: 'repo', executionHostId: 'local', connectionId: null }],
    worktreesByRepo: { repo: [{ id: 'worktree', repoId: 'repo', hostId: 'local' }] }
  }
}))
vi.mock('./creation-draft-readiness', () => ({ isCreationDraftInputReady: mocks.ready }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  refreshLocalRuntimeCapabilities: mocks.capabilities
}))
vi.mock('../web-client-location', () => ({ isWebClientLocation: () => mocks.web }))
vi.mock('../new-workspace', () => ({ CLIENT_PLATFORM: 'darwin' }))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInputVerified: vi.fn(() => {
    throw new Error('PTY fallback forbidden')
  })
}))

import { captureCreationDraftTarget, sendCreationDraft } from './creation-draft-delivery'

const target = {
  executionHostId: 'local',
  worktreeId: 'worktree',
  terminalHandle: 'term-1',
  incarnationId: 'inc-1'
}
const terminal = {
  handle: 'term-1',
  ptyId: 'pty-1',
  incarnationId: 'inc-1',
  worktreeId: 'worktree',
  executionHostId: 'local',
  connected: true,
  writable: true
}
const listing = () => ({ terminals: [{ ...terminal }], totalCount: 1, truncated: false })
const sends = () => mocks.rpc.mock.calls.filter((call) => call[1] === 'terminal.send')
const accepted = (params: { text?: string }) => ({
  send: {
    handle: 'term-1',
    accepted: true,
    bytesWritten: params.text === undefined ? 1 : new TextEncoder().encode(params.text).byteLength
  }
})

async function deliver(text = 'hello') {
  const pending = sendCreationDraft({ target, text })
  await vi.runAllTimersAsync()
  return pending
}

describe('explicit creation draft delivery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { setTimeout })
    mocks.web = false
    mocks.state.worktreesByRepo = { repo: [{ id: 'worktree', repoId: 'repo', hostId: 'local' }] }
    mocks.rpc.mockReset()
    mocks.ready.mockReset().mockResolvedValue(true)
    mocks.capabilities.mockResolvedValue([TERMINAL_SEND_INCARNATION_RUNTIME_CAPABILITY])
    mocks.rpc.mockImplementation(async (_target, method, params) =>
      method === 'terminal.list' ? listing() : accepted(params)
    )
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('refuses startup without writing any bytes', async () => {
    mocks.ready.mockResolvedValue(false)
    expect(await deliver()).toEqual({ status: 'refused', reason: 'input-not-ready' })
    expect(sends()).toEqual([])
  })
  it('preserves uncertainty without Enter or cleanup writes if readiness is lost after paste', async () => {
    mocks.ready.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    expect(await deliver()).toEqual({ status: 'uncertain', reason: 'partial-delivery' })
    expect(sends()).toHaveLength(3)
    expect(sends().some((call) => call[2].enter)).toBe(false)
  })
  it('advertises the implemented terminal.send fence', () => {
    expect(RUNTIME_CAPABILITIES).toContain(TERMINAL_SEND_INCARNATION_RUNTIME_CAPABILITY)
  })
  it('refuses old hosts before any send or target lookup', async () => {
    mocks.capabilities.mockResolvedValue([])
    expect(await deliver()).toEqual({ status: 'refused', reason: 'unsupported-runtime' })
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(await captureCreationDraftTarget(target)).toBeNull()
  })
  it.each(['ssh:host', 'runtime:host'])(
    'refuses %s without contacting local runtime',
    async (executionHostId) => {
      expect(
        await sendCreationDraft({ target: { ...target, executionHostId }, text: 'hello' })
      ).toEqual({ status: 'refused', reason: 'unsupported-host' })
      expect(mocks.rpc).not.toHaveBeenCalled()
    }
  )
  it('refuses paired browser contexts and ownership changes', async () => {
    mocks.web = true
    expect(await deliver()).toMatchObject({ status: 'refused' })
    mocks.web = false
    mocks.state.worktreesByRepo = {
      repo: [{ id: 'worktree', repoId: 'repo', hostId: 'runtime:other' }]
    }
    expect(await deliver()).toMatchObject({ status: 'refused' })
    expect(sends()).toEqual([])
  })
  it.each(['incarnationId', 'worktreeId', 'handle', 'executionHostId'])(
    'refuses mismatched %s before bytes',
    async (field) => {
      mocks.rpc.mockResolvedValue({ ...listing(), terminals: [{ ...terminal, [field]: 'other' }] })
      expect(await deliver()).toEqual({ status: 'refused', reason: 'unverified-target' })
      expect(sends()).toEqual([])
    }
  )
  it('captures only the provided terminal handle without fallback', async () => {
    expect(await captureCreationDraftTarget(target)).toEqual({
      terminalHandle: 'term-1',
      incarnationId: 'inc-1'
    })
    expect(mocks.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'terminal.list', {
      handles: ['term-1'],
      includeVisualLayouts: false
    })
    mocks.rpc.mockResolvedValue({
      ...listing(),
      terminals: [{ ...terminal, handle: 'replacement' }]
    })
    expect(await captureCreationDraftTarget(target)).toBeNull()
  })
  it('sanitizes framing, normalizes line endings and submits exactly once through fenced RPC', async () => {
    expect(await deliver('hello\n\x1b[201~danger')).toEqual({ status: 'delivered' })
    expect(sends().map((call) => call[2].text ?? 'ENTER')).toEqual([
      '\x1b[200~',
      'hello\r␛[201~danger',
      '\x1b[201~',
      'ENTER'
    ])
    for (const call of sends()) {
      expect(call[0]).toEqual({ kind: 'local' })
      expect(call[2]).toMatchObject({
        terminal: 'term-1',
        expectedIncarnationId: 'inc-1',
        requireAgentStatus: 'sendable'
      })
    }
  })
  it('returns refusal when the first frame is refused without bytes', async () => {
    mocks.rpc.mockImplementation(async (_target, method) =>
      method === 'terminal.list' ? listing() : { send: { accepted: false, bytesWritten: 0 } }
    )
    expect(await deliver()).toEqual({ status: 'refused', reason: 'not-sendable' })
    expect(sends()).toHaveLength(1)
  })
  it('reports uncertainty after text acceptance and Enter refusal without retry', async () => {
    mocks.rpc.mockImplementation(async (_target, method, params) =>
      method === 'terminal.list'
        ? listing()
        : params.enter
          ? { send: { accepted: false, bytesWritten: 0 } }
          : accepted(params)
    )
    expect(await deliver()).toEqual({ status: 'uncertain', reason: 'partial-delivery' })
    expect(sends()).toHaveLength(4)
  })
  it('never retries after an ambiguous first send', async () => {
    mocks.rpc.mockImplementation(async (_target, method) => {
      if (method === 'terminal.list') {
        return listing()
      }
      throw new Error('connection lost after host write')
    })
    expect(await deliver()).toEqual({ status: 'uncertain', reason: 'transport' })
    expect(sends()).toHaveLength(1)
  })

  it('bounds every sanitized text RPC to one runtime input chunk', async () => {
    expect(await deliver('é'.repeat(32 * 1024))).toEqual({ status: 'delivered' })
    for (const call of sends()) {
      if (typeof call[2].text === 'string') {
        expect(new TextEncoder().encode(call[2].text).byteLength).toBeLessThanOrEqual(16 * 1024)
      }
    }
    expect(sends().filter((call) => call[2].enter)).toHaveLength(1)
  })

  it('stops after an ownership change between accepted frames', async () => {
    mocks.rpc.mockImplementation(async (_target, method, params) => {
      if (method === 'terminal.list') {
        return listing()
      }
      mocks.state.worktreesByRepo = {
        repo: [{ id: 'worktree', repoId: 'repo', hostId: 'runtime:other' }]
      }
      return accepted(params)
    })
    expect(await deliver()).toEqual({ status: 'uncertain', reason: 'partial-delivery' })
    expect(sends()).toHaveLength(1)
  })

  it('does not claim delivery after an incomplete acknowledgement', async () => {
    mocks.rpc.mockImplementation(async (_target, method) =>
      method === 'terminal.list'
        ? listing()
        : { send: { handle: 'term-1', accepted: true, bytesWritten: 0 } }
    )
    expect(await deliver()).toEqual({ status: 'uncertain', reason: 'partial-delivery' })
    expect(sends()).toHaveLength(1)
  })
})
