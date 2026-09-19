import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pasteDraftToAgentPtyWhenReady, pasteDraftWhenAgentReady } from './agent-paste-draft'

const mocks = vi.hoisted(() => ({
  hostReady: vi.fn(),
  shellReady: vi.fn(),
  inspect: vi.fn(),
  send: vi.fn(),
  processReady: vi.fn()
}))
vi.mock('./antigravity-draft-readiness', () => ({ waitForAntigravityDraftReady: mocks.hostReady }))
vi.mock('./agent-draft-readiness', () => ({ waitForAgentDraftInputReady: mocks.shellReady }))
vi.mock('./agent-ready-wait', () => ({ waitForAgentReady: mocks.processReady }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ settings: {}, ptyIdsByTabId: { tab: ['pty'] }, tabsByWorktree: {} }),
    subscribe: () => () => {}
  }
}))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInputVerified: mocks.send,
  inspectRuntimeTerminalProcess: mocks.inspect
}))

describe('Antigravity continuation delivery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { setTimeout, clearTimeout })
    mocks.hostReady.mockReset()
    mocks.shellReady
      .mockReset()
      .mockImplementation(
        () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 1500))
      )
    mocks.processReady.mockReset().mockResolvedValue({ ready: true })
    mocks.inspect
      .mockReset()
      .mockResolvedValue({ foregroundProcess: 'agy', hasChildProcesses: true })
    mocks.send.mockReset().mockResolvedValue(true)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('leaves context unwritten through a quiet shell until the host confirms the composer', async () => {
    mocks.hostReady.mockImplementation(
      () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 12000))
    )
    const waiting = pasteDraftWhenAgentReady({
      tabId: 'tab',
      agent: 'antigravity',
      content: 'continue context',
      submit: true,
      forcePaste: true
    })
    await vi.advanceTimersByTimeAsync(10000)
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.shellReady).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2100)
    await expect(waiting).resolves.toBe(true)
    expect(mocks.hostReady).toHaveBeenCalledWith('tab', 'pty', 60000, {})
    expect(mocks.send).toHaveBeenLastCalledWith({}, 'pty', '\r')
  })

  it.each(['tab', 'pty'] as const)('rejects process-only fallback on the %s path', async (path) => {
    mocks.hostReady.mockResolvedValue(false)
    const onTimeout = vi.fn()
    const args = {
      tabId: 'tab',
      ptyId: 'pty',
      agent: 'antigravity' as const,
      content: 'preserve context',
      submit: true,
      forcePaste: true,
      onTimeout
    }
    const waiting =
      path === 'tab' ? pasteDraftWhenAgentReady(args) : pasteDraftToAgentPtyWhenReady(args)
    await expect(waiting).resolves.toBe(false)
    expect(onTimeout).toHaveBeenCalledOnce()
    expect(mocks.inspect).not.toHaveBeenCalled()
    expect(mocks.processReady).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })
})
