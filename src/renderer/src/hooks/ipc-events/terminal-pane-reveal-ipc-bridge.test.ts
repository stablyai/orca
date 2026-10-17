import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  TerminalPaneRevealReply,
  TerminalPaneRevealRequest
} from '../../../../shared/terminal-pane-reveal'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'

const mocks = vi.hoisted(() => ({
  revealTerminalPane: vi.fn(),
  ownerEnvironmentIdForWorkspace: vi.fn()
}))

vi.mock('@/lib/reveal-terminal-pane', () => ({
  revealTerminalPane: mocks.revealTerminalPane
}))
vi.mock('@/lib/resolve-owner', () => ({
  runtimeEnvironmentIdUnlessTwin: (state: unknown, workspaceId: string) =>
    mocks.ownerEnvironmentIdForWorkspace(state, workspaceId)
}))
vi.mock('../../store', () => ({ useAppStore: { getState: () => ({}) } }))

import { registerTerminalPaneRevealIpcBridge } from './terminal-pane-reveal-ipc-bridge'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const request: TerminalPaneRevealRequest = {
  requestId: 'request-1',
  worktreeId: 'repo-1::/srv/app',
  tabId: 'host-tab-1',
  leafId: LEAF_ID,
  executionHostId: 'runtime:env-1'
}

function installBridge() {
  let listener: ((data: TerminalPaneRevealRequest) => void) | undefined
  const reply = vi.fn<(data: TerminalPaneRevealReply) => void>()
  const cleanup = vi.fn()
  vi.stubGlobal('window', {
    api: {
      ui: {
        onRevealTerminalPane: (callback: (data: TerminalPaneRevealRequest) => void) => {
          listener = callback
          return cleanup
        },
        replyTerminalPaneReveal: reply
      }
    }
  })
  const unsubs: (() => void)[] = []
  registerTerminalPaneRevealIpcBridge(unsubs)
  return { deliver: (data: TerminalPaneRevealRequest) => listener?.(data), reply, cleanup, unsubs }
}

describe('registerTerminalPaneRevealIpcBridge', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.unstubAllGlobals()
    mocks.revealTerminalPane.mockReturnValue(true)
    mocks.ownerEnvironmentIdForWorkspace.mockReturnValue(null)
  })

  it("reveals a paired server's pane under the id this window mirrors its tab with", () => {
    const { deliver, reply, cleanup, unsubs } = installBridge()

    deliver(request)

    expect(mocks.revealTerminalPane).toHaveBeenCalledWith({
      worktreeId: request.worktreeId,
      tabId: toWebTerminalSurfaceTabId('host-tab-1'),
      leafId: LEAF_ID,
      executionHostId: 'runtime:env-1'
    })
    expect(reply).toHaveBeenCalledWith({ requestId: 'request-1', revealed: true })
    unsubs.forEach((unsubscribe) => unsubscribe())
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('finds the owning server from the workspace when the caller names no host', () => {
    const { deliver } = installBridge()
    mocks.ownerEnvironmentIdForWorkspace.mockReturnValue('env-1')

    deliver({ ...request, executionHostId: null })

    expect(mocks.revealTerminalPane).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: toWebTerminalSurfaceTabId('host-tab-1') })
    )
  })

  it.each<[string, Partial<TerminalPaneRevealRequest>]>([
    ['a local workspace', { executionHostId: null }],
    ['an SSH workspace this app runs', { executionHostId: 'ssh:box' }],
    ['a tab already named as this window mirrors it', { tabId: 'web-terminal-host-tab-1' }]
  ])('keeps the tab id of %s', (_case, overrides) => {
    const { deliver } = installBridge()

    deliver({ ...request, ...overrides })

    expect(mocks.revealTerminalPane).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: overrides.tabId ?? 'host-tab-1' })
    )
  })

  it('answers false when this window does not know the workspace', () => {
    const { deliver, reply } = installBridge()
    mocks.revealTerminalPane.mockReturnValue(false)

    deliver(request)

    expect(reply).toHaveBeenCalledWith({ requestId: 'request-1', revealed: false })
  })

  it('still answers when the reveal throws, so the caller is not left waiting', () => {
    const { deliver, reply } = installBridge()
    mocks.revealTerminalPane.mockImplementation(() => {
      throw new Error('store unavailable')
    })

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => deliver(request)).not.toThrow()
    expect(reply).toHaveBeenCalledWith({ requestId: 'request-1', revealed: false })
    expect(consoleError).toHaveBeenCalledWith('Failed to reveal terminal pane:', expect.any(Error))
    consoleError.mockRestore()
  })
})
