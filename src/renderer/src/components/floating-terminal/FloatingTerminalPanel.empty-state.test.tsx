import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  makeTab,
  setFloatingTabs,
  storeBox,
  type FloatingPanelStoreState
} from './floating-terminal-panel-test-fixtures'
import { mocks, setupFloatingTerminalPanelTest } from './floating-terminal-panel-test-harness'
import {
  collectPropValues,
  findByTypeName,
  flushAsyncWork,
  renderPanel,
  runEffects,
  type ReactElementLike
} from './floating-terminal-panel-render-probe'

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  const { createReactHookOverrides } = await import('./floating-terminal-panel-test-module-mocks')
  return { ...actual, ...createReactHookOverrides() }
})

vi.mock('@/store', async () => {
  return (await import('./floating-terminal-panel-test-module-mocks')).createAppStoreModule()
})

vi.mock('@/components/tab-bar/TabBar', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createTabBarModule()
})

vi.mock('@/components/terminal-pane/TerminalPane', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createTerminalPaneModule()
})

vi.mock('@/components/terminal-pane/use-terminal-tab-cold-parking', async () => {
  return (await import('./floating-terminal-panel-test-module-mocks')).createColdParkingModule()
})

vi.mock('@/components/terminal-pane/terminal-parked-tab-watchers', async () => {
  return (
    await import('./floating-terminal-panel-test-module-mocks')
  ).createParkedTabWatchersModule()
})

vi.mock('@/components/terminal-pane/terminal-ime-input-context-refresh', async () => {
  return (
    await import('./floating-terminal-panel-test-module-mocks')
  ).createImeInputContextRefreshModule()
})

vi.mock('@/components/terminal/terminal-tab-actions', async () => {
  return (
    await import('./floating-terminal-panel-test-module-mocks')
  ).createTerminalTabActionsModule()
})

vi.mock('@/store/pinned-tab-close-guard', async () => {
  return (
    await import('./floating-terminal-panel-test-module-mocks')
  ).createPinnedTabCloseGuardModule()
})

vi.mock('@/components/browser-pane/BrowserPane', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createBrowserPaneModule()
})

vi.mock('@/components/emulator-pane/EmulatorPane', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createEmulatorPaneModule()
})

vi.mock('@/components/editor/EditorPanel', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createEditorPanelModule()
})

vi.mock('@/components/ui/button', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createButtonModule()
})

vi.mock('@/components/contextual-tours/use-contextual-tour', async () => {
  return (await import('./floating-terminal-panel-test-module-mocks')).createContextualTourModule()
})

vi.mock('@/components/ui/dialog', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createDialogModule()
})

vi.mock('@/components/terminal/useTerminalSaveDialog', async () => {
  return (
    await import('./floating-terminal-panel-test-module-mocks')
  ).createTerminalSaveDialogModule()
})

vi.mock('@/runtime/web-runtime-session', async () => {
  return (
    await import('./floating-terminal-panel-test-module-mocks')
  ).createWebRuntimeSessionModule()
})

vi.mock('@/lib/connection-context', async () => {
  return (
    await import('./floating-terminal-panel-test-module-mocks')
  ).createConnectionContextModule()
})

// Why inline and sync: this module is imported by the test file itself, so an async factory
// resolves too late and the panel ends up calling a second copy of the mock.
vi.mock('@/lib/create-untitled-markdown', () => ({
  createUntitledMarkdownFileWithTemplateSelection: vi.fn()
}))

vi.mock('@/lib/ipc-error', async () => {
  return (await import('./floating-terminal-panel-test-module-mocks')).createIpcErrorModule()
})

vi.mock('sonner', async () => {
  return (await import('./floating-terminal-panel-test-module-mocks')).createSonnerModule()
})

vi.mock('@/lib/focus-terminal-tab-surface', async () => {
  return (
    await import('./floating-terminal-panel-test-module-mocks')
  ).createFocusTerminalTabSurfaceModule()
})

vi.mock('@/lib/orchestration-setup-state', async () => {
  return (
    await import('./floating-terminal-panel-test-module-mocks')
  ).createOrchestrationSetupStateModule()
})

vi.mock('./FloatingTerminalOrchestrationDialog', async () => {
  return (
    await import('./floating-terminal-panel-component-stubs')
  ).createOrchestrationDialogModule()
})

vi.mock('./FloatingTerminalResizeHandles', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createResizeHandlesModule()
})

vi.mock('./FloatingTerminalToggleButton', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createToggleButtonModule()
})

vi.mock('./FloatingTerminalWindowControls', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createWindowControlsModule()
})

vi.mock('@/components/ShortcutKeyCombo', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createShortcutKeyComboModule()
})

describe('FloatingTerminalPanel close behavior', () => {
  beforeEach(setupFloatingTerminalPanelTest)

  afterEach(() => {
    vi.unstubAllGlobals()
  })
  it('does not bootstrap a terminal tab when the panel opens empty', async () => {
    await renderPanel(false)
    runEffects()
    await flushAsyncWork()
    expect(mocks.createTab).not.toHaveBeenCalled()

    await renderPanel(true)
    runEffects()
    await flushAsyncWork()
    expect(mocks.createTab).not.toHaveBeenCalled()

    await renderPanel(true)
    runEffects()
    await flushAsyncWork()
    expect(mocks.createTab).not.toHaveBeenCalled()

    await renderPanel(false)
    runEffects()
    await renderPanel(true)
    runEffects()
    await flushAsyncWork()
    expect(mocks.createTab).not.toHaveBeenCalled()
  })

  it('requests the floating workspace tour only when the panel is open', async () => {
    const persisted = Promise.resolve()

    await renderPanel(false, vi.fn(), {
      wasPreviouslyInteracted: false,
      persisted,
      recordFeatureInteractionForTour: false
    })

    expect(mocks.useContextualTour).toHaveBeenLastCalledWith(
      'floating-workspace',
      false,
      'floating_workspace_visible',
      {
        recordFeatureInteraction: false,
        featureInteractionPersisted: persisted,
        wasFeaturePreviouslyInteracted: false
      }
    )

    await renderPanel(true, vi.fn(), {
      wasPreviouslyInteracted: true,
      persisted,
      recordFeatureInteractionForTour: false
    })

    expect(mocks.useContextualTour).toHaveBeenLastCalledWith(
      'floating-workspace',
      true,
      'floating_workspace_visible',
      {
        recordFeatureInteraction: false,
        featureInteractionPersisted: persisted,
        wasFeaturePreviouslyInteracted: true
      }
    )
  })

  it('records the floating workspace tour interaction when the open snapshot deferred persistence', async () => {
    await renderPanel(true, vi.fn(), {
      wasPreviouslyInteracted: false,
      recordFeatureInteractionForTour: true
    })

    expect(mocks.useContextualTour).toHaveBeenLastCalledWith(
      'floating-workspace',
      true,
      'floating_workspace_visible',
      {
        recordFeatureInteraction: true,
        featureInteractionPersisted: undefined,
        wasFeaturePreviouslyInteracted: false
      }
    )
  })

  it('targets the empty-state actions without co-mounting the surface fallback', async () => {
    const element = await renderPanel(true)
    const emptyState = findByTypeName(element, 'FloatingTerminalEmptyState')
    const renderedEmptyState = (
      emptyState.type as (props: Record<string, unknown>) => ReactElementLike
    )(emptyState.props)

    expect(collectPropValues(element, 'data-contextual-tour-target')).not.toContain(
      'floating-workspace-surface'
    )
    expect(collectPropValues(renderedEmptyState, 'data-contextual-tour-target')).toEqual([
      'floating-workspace-new-terminal',
      'floating-workspace-new-markdown'
    ])
  })

  it('targets the non-empty panel surface when the empty-state actions are absent', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' })])

    const element = await renderPanel(true)

    expect(() => findByTypeName(element, 'FloatingTerminalEmptyState')).toThrow(
      'FloatingTerminalEmptyState not found'
    )
    expect(collectPropValues(element, 'data-contextual-tour-target')).toContain(
      'floating-workspace-surface'
    )
    expect(collectPropValues(element, 'data-contextual-tour-target')).not.toContain(
      'floating-workspace-new-terminal'
    )
    expect(collectPropValues(element, 'data-contextual-tour-target')).not.toContain(
      'floating-workspace-new-markdown'
    )
  })

  it('minimizes the empty floating workspace from the empty state', async () => {
    const onOpenChange = vi.fn()
    const element = await renderPanel(true, onOpenChange)

    const emptyState = findByTypeName(element, 'FloatingTerminalEmptyState')
    ;(emptyState.props.onClose as () => void)()

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(mocks.closeTab).not.toHaveBeenCalled()
    expect(mocks.closeFile).not.toHaveBeenCalled()
    expect(mocks.closeBrowserTab).not.toHaveBeenCalled()
  })

  it('shows the empty state when only stale unified tabs remain', async () => {
    const state = storeBox.state as FloatingPanelStoreState
    const staleTab = makeTab({ id: 'stale-tab' })
    setFloatingTabs([staleTab])
    state.tabsByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: [] }
    state.activeTabIdByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: null }

    const element = await renderPanel(true)
    const emptyState = findByTypeName(element, 'FloatingTerminalEmptyState')

    expect(emptyState).toBeTruthy()
  })
})
