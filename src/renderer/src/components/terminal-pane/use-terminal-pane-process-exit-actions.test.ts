// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TerminalPaneCloseController } from './use-terminal-pane-close-actions'
import type { PtyConnectionDeps } from './pty-connection-types'

const mocks = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock('./pty-connection', () => ({ connectPanePty: mocks.connect }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
import { useTerminalPaneProcessExitActions } from './use-terminal-pane-process-exit-actions'

function fixture() {
  const dispose = vi.fn()
  mocks.connect.mockReturnValue({ dispose })
  const pane = {
    id: 1,
    leafId: 'e70e9e56-1645-43ad-9718-a55b44f923d5',
    container: document.createElement('div')
  }
  const bindings = new Map()
  const controller = {
    managerRef: { current: { getPanes: () => [pane], setActivePane: vi.fn() } },
    paneTransportsRef: { current: new Map() },
    panePtyBindingsRef: { current: bindings },
    savedLayout: {},
    pendingCodexPaneRestartIds: {},
    syncPanePtyLayoutBinding: vi.fn(),
    setCacheTimerStartedAt: vi.fn(),
    setTerminalError: vi.fn(),
    setTerminalErrorsByPaneId: vi.fn(),
    tabId: 'tab',
    worktreeId: 'folder:workspace',
    cwd: '/workspace'
  } as unknown as TerminalPaneCloseController
  const hook = renderHook(() => useTerminalPaneProcessExitActions(controller))
  return { ...hook, bindings, dispose }
}

describe('native chat replacement startup lifetime', () => {
  it('rejects a pending restart when its pane binding is disposed before connect', async () => {
    const { result, bindings, dispose } = fixture()
    const pending = result.current.handleRestartChatPane(1, { command: 'grok' }, '/workspace')
    const rejected = expect(pending).rejects.toThrow('replacement provider could not start')
    bindings.get(1).dispose()
    await rejected
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('settles on the startup binding and tolerates later disposal', async () => {
    const { result, bindings } = fixture()
    const pending = result.current.handleRestartChatPane(1, { command: 'grok' }, '/workspace')
    const deps = mocks.connect.mock.lastCall?.[2] as PtyConnectionDeps
    deps.onStartupBound?.()
    bindings.get(1).dispose()
    await expect(pending).resolves.toBeUndefined()
  })
})
