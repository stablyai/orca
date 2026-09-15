// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import type { TerminalPaneTitleController } from './use-terminal-pane-title-state'

const { submitMock, lockedMock } = vi.hoisted(() => ({ submitMock: vi.fn(), lockedMock: vi.fn() }))
vi.mock('./terminal-rich-input-submit', () => ({ submitTerminalRichInput: submitMock }))
vi.mock('@/lib/pane-manager/mobile-driver-state', () => ({ isPtyLocked: lockedMock }))
import { useTerminalPaneRichInput } from './use-terminal-pane-rich-input'

beforeEach(() => {
  lockedMock.mockReturnValue(false)
  submitMock.mockResolvedValue({ status: 'submitted', deliveryConfirmed: true })
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callback(0)
    return 1
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

function harness() {
  const pane = { id: 1, leafId: 'leaf-1', terminal: { focus: vi.fn() } } as unknown as ManagedPane
  const sibling = {
    id: 2,
    leafId: 'leaf-2',
    terminal: { focus: vi.fn() }
  } as unknown as ManagedPane
  let active = pane
  const transport = { getPtyId: () => 'remote-pty', getConnectionId: () => 'ssh-1' }
  const manager = { getActivePane: () => active, getPanes: () => [pane, sibling] }
  const controller = {
    managerRef: { current: manager },
    paneTransportsRef: { current: new Map([[pane.id, transport]]) },
    tabId: 'tab-1',
    worktreeId: 'folder-workspace'
  } as unknown as TerminalPaneTitleController
  const hook = renderHook(({ chat }) => useTerminalPaneRichInput(controller, chat), {
    initialProps: { chat: false }
  })
  return {
    pane,
    sibling,
    transport,
    controller,
    hook,
    activateSibling: () => {
      active = sibling
    }
  }
}

describe('useTerminalPaneRichInput', () => {
  it('toggles the active leaf without lending a split sibling its open state', () => {
    const { hook, pane, sibling, activateSibling } = harness()
    act(() => hook.result.current.toggleRichInput())
    expect(hook.result.current.richInputLeafId).toBe(pane.leafId)
    activateSibling()
    act(() => hook.result.current.toggleRichInput())
    expect(hook.result.current.richInputLeafId).toBe(sibling.leafId)
    act(() => hook.result.current.toggleRichInput())
    expect(hook.result.current.richInputLeafId).toBeNull()
    expect(sibling.terminal.focus).toHaveBeenCalledOnce()
    expect(pane.terminal.focus).not.toHaveBeenCalled()
  })

  it('does not open a composer over native chat', () => {
    const { hook } = harness()
    hook.rerender({ chat: true })
    act(() => hook.result.current.toggleRichInput())
    expect(hook.result.current.richInputLeafId).toBeNull()
  })

  it('submits through the captured leaf transport with live ownership getters', async () => {
    const { hook, pane, transport, controller } = harness()
    await expect(
      hook.result.current.submitRichInputForPane(pane, 'prompt', ['/remote/image.png'])
    ).resolves.toEqual({ status: 'submitted', deliveryConfirmed: true })
    expect(submitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pane,
        transport,
        text: 'prompt',
        imagePaths: ['/remote/image.png'],
        tabId: 'tab-1',
        worktreeId: 'folder-workspace'
      })
    )
    const submission = submitMock.mock.calls[0]![0]
    expect(submission.getManager()).toBe(controller.managerRef.current)
    expect(submission.getPaneTransports()).toBe(controller.paneTransportsRef.current)
  })

  it('refuses a mobile-locked PTY before pasting any input', async () => {
    const { hook, pane } = harness()
    lockedMock.mockReturnValue(true)
    await expect(hook.result.current.submitRichInputForPane(pane, 'prompt', [])).resolves.toEqual({
      status: 'not-started'
    })
    expect(lockedMock).toHaveBeenCalledWith('remote-pty')
    expect(submitMock).not.toHaveBeenCalled()
  })
})
