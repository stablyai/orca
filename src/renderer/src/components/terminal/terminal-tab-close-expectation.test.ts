import { beforeEach, describe, expect, it, vi } from 'vitest'

const { callRuntimeRpcMock } = vi.hoisted(() => ({ callRuntimeRpcMock: vi.fn() }))

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: callRuntimeRpcMock }))

import { assertTerminalTabCloseExpectation } from './terminal-tab-close-expectation'

const expected = {
  terminalHandle: 'term-a',
  ptyId: 'pty-a',
  leafId: 'leaf-a',
  incarnationId: 'inc-a'
}

function state(ptyId = 'pty-a') {
  return {
    tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
    unifiedTabsByWorktree: {},
    terminalLayoutsByTabId: {
      'tab-1': {
        ptyIdsByLeafId: { 'leaf-a': ptyId }
      }
    }
  }
}

describe('terminal tab close expectation', () => {
  beforeEach(() => {
    callRuntimeRpcMock.mockReset()
    callRuntimeRpcMock.mockResolvedValue({ verified: true })
  })

  it('accepts the unchanged host and renderer binding', async () => {
    await expect(
      assertTerminalTabCloseExpectation(() => state() as never, 'tab-1', expected)
    ).resolves.toBeUndefined()
  })

  it('rejects a reused PTY id with a replacement incarnation', async () => {
    callRuntimeRpcMock.mockRejectedValue(new Error('terminal_handle_stale'))

    await expect(
      assertTerminalTabCloseExpectation(() => state() as never, 'tab-1', expected)
    ).rejects.toThrow('terminal_handle_stale')
  })

  it('rejects a replacement renderer PTY before local retirement', async () => {
    await expect(
      assertTerminalTabCloseExpectation(() => state('pty-b') as never, 'tab-1', expected)
    ).rejects.toThrow('terminal_handle_stale')
  })
})
