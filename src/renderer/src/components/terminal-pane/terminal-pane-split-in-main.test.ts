import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { provideServerLayoutApplyRoutes } from '@/runtime/server-layout-apply-routes'
import { splitPaneFirstSize, splitPaneInMain, splitServerPane } from './terminal-pane-split-in-main'

const mocks = vi.hoisted(
  (): {
    callRuntimeRpc: ReturnType<typeof vi.fn>
    pairedServer: string | null
    actsAsToday: boolean
    recordCreatedTerminalPaneSplit: ReturnType<typeof vi.fn>
  } => ({
    callRuntimeRpc: vi.fn(),
    pairedServer: null,
    actsAsToday: false,
    recordCreatedTerminalPaneSplit: vi.fn()
  })
)
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/lib/resolve-owner', () => ({
  runtimeEnvironmentIdUnlessTwin: () => mocks.pairedServer
}))
vi.mock('@/runtime/layout-apply-send', () => ({ refusalActsAsToday: () => mocks.actsAsToday }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('./terminal-pane-split-completion', () => ({
  recordCreatedTerminalPaneSplit: mocks.recordCreatedTerminalPaneSplit
}))

const REQUEST = {
  worktreeId: 'wt-1',
  tabId: 'tab-1',
  sourceLeafId: 'leaf-1',
  direction: 'vertical' as const
}

describe('a window split in a layout-owner build', () => {
  beforeEach(() => {
    mocks.callRuntimeRpc.mockReset()
    mocks.recordCreatedTerminalPaneSplit.mockReset()
    mocks.pairedServer = null
    mocks.actsAsToday = false
  })

  it('asks main to write and start the pane under the window’s id, with its folder and size', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ split: {} })
    const asToday = vi.fn()

    expect(
      splitPaneInMain(
        {
          ...REQUEST,
          cwd: Promise.resolve('/repo/src'),
          initialSize: { cols: 40, rows: 24 },
          command: 'make test',
          telemetry: { source: 'keyboard' }
        },
        asToday
      )
    ).toBe(true)

    await vi.waitFor(() => expect(mocks.recordCreatedTerminalPaneSplit).toHaveBeenCalled())
    const [target, method, params] = mocks.callRuntimeRpc.mock.calls[0]!
    expect(target).toEqual({ kind: 'local' })
    expect(method).toBe('terminal.split')
    expect(params).toEqual({
      pane: { worktreeId: 'wt-1', tabId: 'tab-1', leafId: 'leaf-1' },
      newLeafId: expect.any(String),
      direction: 'vertical',
      cwd: '/repo/src',
      initialSize: { cols: 40, rows: 24 },
      command: 'make test'
    })
    expect(isTerminalLeafId(params.newLeafId)).toBe(true)
    expect(mocks.recordCreatedTerminalPaneSplit).toHaveBeenCalledWith(true, {
      source: 'keyboard',
      direction: 'vertical'
    })
    expect(asToday).not.toHaveBeenCalled()
  })

  it('splits as today when main finds the tab is a paired server’s twin', async () => {
    mocks.actsAsToday = true
    mocks.callRuntimeRpc.mockRejectedValue(new Error('host_not_owned'))
    const asToday = vi.fn()

    splitPaneInMain(REQUEST, asToday)

    await vi.waitFor(() => expect(asToday).toHaveBeenCalledTimes(1))
    expect(mocks.recordCreatedTerminalPaneSplit).not.toHaveBeenCalled()
  })

  it('keeps a startup split’s source focused until the pane mounts, or forgets it on failure', async () => {
    const { takePaneMountUnfocused } = await import('@/runtime/layout-owner-pane-intents')
    mocks.callRuntimeRpc.mockResolvedValue({ split: {} })
    splitPaneInMain({ ...REQUEST, keepSourceFocused: true }, vi.fn())
    await vi.waitFor(() => expect(mocks.callRuntimeRpc).toHaveBeenCalled())
    const leafId = mocks.callRuntimeRpc.mock.calls[0]![2].newLeafId
    expect(takePaneMountUnfocused('tab-1', leafId)).toBe(true)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.callRuntimeRpc.mockRejectedValue(new Error('shell not found'))
    splitPaneInMain({ ...REQUEST, keepSourceFocused: true }, vi.fn())
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    const failedLeafId = mocks.callRuntimeRpc.mock.calls[1]![2].newLeafId
    expect(takePaneMountUnfocused('tab-1', failedLeafId)).toBe(false)
    warn.mockRestore()
  })

  it('draws nothing itself when main refuses or the start fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.callRuntimeRpc.mockRejectedValue(new Error('shell not found'))
    const asToday = vi.fn()

    splitPaneInMain(REQUEST, asToday)

    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    expect(asToday).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('leaves a paired server’s workspace to the caller', () => {
    mocks.pairedServer = 'env-1'

    expect(splitPaneInMain(REQUEST, vi.fn())).toBe(false)
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('takes a handle-less pane’s split to the server’s main whose frames draw the workspace', async () => {
    mocks.pairedServer = 'env-1'
    mocks.callRuntimeRpc.mockResolvedValue({ split: {} })
    const stop = provideServerLayoutApplyRoutes('env-1', (worktreeId) =>
      worktreeId === 'wt-1'
        ? {
            environmentId: 'env-1',
            serverTabId: (tabId) => (tabId === 'tab-1' ? 'server-tab-1' : null),
            desktopTabId: (tabId) => tabId,
            redraw: vi.fn()
          }
        : null
    )
    try {
      expect(splitServerPane({ ...REQUEST, cwd: '/srv/wt' })).toBe(true)
      await vi.waitFor(() => expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(1))
      const [target, method, params] = mocks.callRuntimeRpc.mock.calls[0]!
      expect(target).toEqual({ kind: 'environment', environmentId: 'env-1' })
      expect(method).toBe('terminal.split')
      expect(params).toMatchObject({
        pane: { worktreeId: 'wt-1', tabId: 'server-tab-1', leafId: 'leaf-1' },
        direction: 'vertical',
        cwd: '/srv/wt'
      })
      expect(isTerminalLeafId(params.newLeafId)).toBe(true)

      // A tab the server's frames do not hold, or a workspace they do not draw, keeps today's path.
      expect(splitServerPane({ ...REQUEST, tabId: 'tab-elsewhere' })).toBe(false)
      expect(splitServerPane({ ...REQUEST, worktreeId: 'wt-2' })).toBe(false)
      expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(1)
    } finally {
      stop()
    }
  })

  it('leaves a server workspace no layout-intents stream draws, and main’s own, to the caller', () => {
    mocks.pairedServer = 'env-1'
    expect(splitServerPane(REQUEST)).toBe(false)
    mocks.pairedServer = null
    expect(splitServerPane(REQUEST)).toBe(false)
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('sizes the new pane as its share of the source pane', () => {
    expect(splitPaneFirstSize({ cols: 81, rows: 24 }, 'vertical')).toEqual({ cols: 40, rows: 24 })
    expect(splitPaneFirstSize({ cols: 80, rows: 25 }, 'horizontal')).toEqual({
      cols: 80,
      rows: 12
    })
  })
})
