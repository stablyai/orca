import { expect, it } from 'vitest'
import { setupTerminalCreateSurfacing } from './ipc-events-terminal-create-test-harness'

it('routes notification focus through the multiplexer without changing views', async () => {
  const { storeState, setActiveView, dispatchEvent, focusTerminalListenerRef } =
    await setupTerminalCreateSurfacing(() => false)
  storeState.activeView = 'multiplexer'
  setActiveView.mockClear()
  dispatchEvent.mockClear()
  focusTerminalListenerRef.current!({
    worktreeId: 'wt-4',
    tabId: 'tab-focus',
    leafId: 'leaf-focus',
    flashFocusedPane: true
  })
  expect(setActiveView).not.toHaveBeenCalled()
  expect(dispatchEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'orca:workspace-multiplexer-add-request',
      detail: expect.objectContaining({
        worktreeId: 'wt-4',
        terminal: expect.objectContaining({
          tabId: 'tab-focus',
          leafId: 'leaf-focus',
          flashFocusedPane: true
        })
      })
    })
  )
})
