import type { Page } from '@stablyai/playwright-test'

/** Bounded input counts and selection stacks; never retain input text or terminal buffers. */
export async function captureOrcadMigrationInputDiagnostics(page: Page) {
  return page.evaluateHandle(() => {
    const store = window.__store!
    const initialTab = store.getState().activeTabId
    const initialWorktree = store.getState().activeWorktreeId
    const manager = initialTab ? window.__paneManagers?.get(initialTab) : undefined
    const initialPane = manager?.getActivePane?.()
    const dispositions = (
      window as Window & {
        __terminalInputDisposition?: {
          begin: (paneId: number, ptyId?: string) => void
          finish: () => Record<string, number>
        }
      }
    ).__terminalInputDisposition
    if (initialPane) {
      dispositions?.begin(initialPane.id, initialPane.container.dataset.ptyId)
    }
    const textarea = initialPane?.container.querySelector('.xterm-helper-textarea')
    let keydowns = 0
    let targetedKeydowns = 0
    let inputEvents = 0
    let inputCodeUnits = 0
    const events: {
      kind: string
      tabChanged: boolean
      host: string | null
      connected: boolean
      focused: boolean
      samePane: boolean
      activeTabId: string | null
      initialTabRetained: boolean
      selectionStack?: string
    }[] = []
    const record = (kind: string, selectionStack?: string) => {
      if (events.length >= 32) {
        return
      }
      const state = store.getState()
      const active = state.activeTabId
        ? window.__paneManagers?.get(state.activeTabId)?.getActivePane?.()
        : undefined
      events.push({
        kind,
        tabChanged: state.activeTabId !== initialTab,
        host: state.activeWorkspaceExecutionHostId ?? null,
        connected: Boolean(initialPane?.container.isConnected),
        focused: document.activeElement === textarea,
        samePane: active?.container === initialPane?.container,
        activeTabId: state.activeTabId,
        initialTabRetained: Boolean(
          initialWorktree &&
          state.tabsByWorktree[initialWorktree]?.some((tab) => tab.id === initialTab)
        ),
        ...(selectionStack ? { selectionStack } : {})
      })
    }
    const keydown = (event: KeyboardEvent) => {
      keydowns++
      if (event.target === textarea) {
        targetedKeydowns++
      }
      if (keydowns === 1 || keydowns === 2 || event.key === 'Enter') {
        record('keyboard')
      }
    }
    const focus = () => record('focus')
    const input = initialPane?.terminal.onData((data) => {
      inputEvents++
      inputCodeUnits += data.length
      if (inputEvents <= 2) {
        record('terminal-input')
      }
    })
    const initialState = store.getState()
    let previous = `${initialState.activeTabId}|${initialState.activeWorkspaceExecutionHostId}|${initialState.activeWorktreeId}`
    let selectionStacks = 0
    const unsubscribe = store.subscribe((state) => {
      const signature = `${state.activeTabId}|${state.activeWorkspaceExecutionHostId}|${state.activeWorktreeId}`
      if (signature !== previous) {
        previous = signature
        record(
          'selection',
          selectionStacks++ < 4
            ? new Error('migration-input-selection-change').stack?.slice(0, 4096)
            : undefined
        )
      }
    })
    document.addEventListener('keydown', keydown, true)
    document.addEventListener('focusin', focus, true)
    document.addEventListener('focusout', focus, true)
    record('start')
    return {
      finish() {
        record('finish')
        unsubscribe()
        input?.dispose()
        document.removeEventListener('keydown', keydown, true)
        document.removeEventListener('focusin', focus, true)
        document.removeEventListener('focusout', focus, true)
        return {
          keydowns,
          targetedKeydowns,
          inputEvents,
          inputCodeUnits,
          events,
          dispositions: dispositions?.finish()
        }
      }
    }
  })
}
