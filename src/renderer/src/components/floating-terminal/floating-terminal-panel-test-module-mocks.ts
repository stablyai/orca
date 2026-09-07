import { vi } from 'vitest'
import type { Mock } from 'vitest'
import {
  hookRuntime,
  mocks,
  parkingBox,
  saveDialogBox,
  type EffectCallback,
  type FloatingTerminalPanelMocks
} from './floating-terminal-panel-test-harness'
import { storeBox, type FloatingPanelStoreState } from './floating-terminal-panel-test-fixtures'

export function createReactHookOverrides() {
  return {
    useCallback: <T>(callback: T) => callback,
    useEffect: (effect: EffectCallback) => {
      hookRuntime.effects.push(effect)
    },
    useLayoutEffect: (effect: EffectCallback) => {
      hookRuntime.layoutEffects.push(effect)
    },
    useMemo: <T>(factory: () => T) => factory(),
    useRef: <T>(initialValue: T) => {
      const index = hookRuntime.index
      hookRuntime.index += 1
      if (hookRuntime.values[index] === undefined) {
        hookRuntime.values[index] = { current: initialValue }
      }
      return hookRuntime.values[index] as { current: T }
    },
    useState: <T>(initialValue: T | (() => T)) => {
      const index = hookRuntime.index
      hookRuntime.index += 1
      if (hookRuntime.values[index] === undefined) {
        hookRuntime.values[index] =
          typeof initialValue === 'function' ? (initialValue as () => T)() : initialValue
      }
      const setValue = (nextValue: T | ((current: T) => T)): void => {
        hookRuntime.values[index] =
          typeof nextValue === 'function'
            ? (nextValue as (current: T) => T)(hookRuntime.values[index] as T)
            : nextValue
      }
      return [hookRuntime.values[index] as T, setValue] as const
    }
  }
}

export function createAppStoreModule() {
  const useAppStore = Object.assign(
    (selector: (state: FloatingPanelStoreState) => unknown) =>
      selector(storeBox.state as FloatingPanelStoreState),
    {
      getState: () => storeBox.state as FloatingPanelStoreState
    }
  )
  return { useAppStore }
}

export function createColdParkingModule() {
  return {
    useTerminalTabColdParking: () => parkingBox.parkedTabIds
  }
}

export function createParkedTabWatchersModule(): Pick<
  FloatingTerminalPanelMocks,
  'shouldDeferParkedPtyExitTabClose'
> {
  return {
    shouldDeferParkedPtyExitTabClose: mocks.shouldDeferParkedPtyExitTabClose
  }
}

export function createImeInputContextRefreshModule(): Pick<
  FloatingTerminalPanelMocks,
  'isTerminalImeInputContextRefreshing'
> {
  return {
    isTerminalImeInputContextRefreshing: mocks.isTerminalImeInputContextRefreshing
  }
}

// closeFloatingItemConfirmed routes terminals through closeTerminalTab (own pin guard + F9
// force-reenter) and non-terminals through guardPinnedTabClose; mock both to assert routing.
export function createTerminalTabActionsModule(): Pick<
  FloatingTerminalPanelMocks,
  'closeTerminalTab'
> {
  return {
    closeTerminalTab: mocks.closeTerminalTab
  }
}

export function createPinnedTabCloseGuardModule(): Pick<
  FloatingTerminalPanelMocks,
  'guardPinnedTabClose'
> & { resolvePinnedTabLabel: () => string } {
  return {
    guardPinnedTabClose: mocks.guardPinnedTabClose,
    resolvePinnedTabLabel: () => 'Floating Tab'
  }
}

export function createContextualTourModule(): Pick<
  FloatingTerminalPanelMocks,
  'useContextualTour'
> {
  return {
    useContextualTour: mocks.useContextualTour
  }
}

export function createTerminalSaveDialogModule() {
  return {
    useTerminalSaveDialog: () => ({
      handleSaveDialogCancel: () => {
        saveDialogBox.fileId = null
      },
      handleSaveDialogDiscard: () => {
        if (saveDialogBox.fileId) {
          mocks.markFileDirty(saveDialogBox.fileId, false)
          mocks.closeFile(saveDialogBox.fileId)
        }
        saveDialogBox.fileId = null
      },
      handleSaveDialogSave: () => {
        saveDialogBox.fileId = null
      },
      requestCloseFile: (fileId: string) => {
        const file = (storeBox.state as FloatingPanelStoreState).openFiles.find(
          (candidate) => candidate.id === fileId
        )
        if (file?.isDirty) {
          saveDialogBox.fileId = fileId
          return
        }
        mocks.closeFile(fileId)
      },
      saveDialogFile: saveDialogBox.fileId
        ? ((storeBox.state as FloatingPanelStoreState).openFiles.find(
            (file) => file.id === saveDialogBox.fileId
          ) ?? null)
        : null,
      saveDialogFileId: saveDialogBox.fileId
    })
  }
}

export function createWebRuntimeSessionModule(): Pick<
  FloatingTerminalPanelMocks,
  | 'activateWebRuntimeSessionTab'
  | 'closeWebRuntimeSessionTab'
  | 'createWebRuntimeSessionBrowserTab'
  | 'createWebRuntimeSessionTerminal'
  | 'isWebRuntimeSessionActive'
> {
  return {
    activateWebRuntimeSessionTab: mocks.activateWebRuntimeSessionTab,
    closeWebRuntimeSessionTab: mocks.closeWebRuntimeSessionTab,
    createWebRuntimeSessionBrowserTab: mocks.createWebRuntimeSessionBrowserTab,
    createWebRuntimeSessionTerminal: mocks.createWebRuntimeSessionTerminal,
    isWebRuntimeSessionActive: mocks.isWebRuntimeSessionActive
  }
}

export function createConnectionContextModule() {
  return {
    getConnectionId: () => undefined
  }
}

export function createIpcErrorModule() {
  return {
    extractIpcErrorMessage: (_err: unknown, fallback: string) => fallback
  }
}

export function createSonnerModule(): { toast: { error: Mock<(message: string) => void> } } {
  return {
    toast: { error: vi.fn() }
  }
}

export function createFocusTerminalTabSurfaceModule(): Pick<
  FloatingTerminalPanelMocks,
  'focusTerminalTabSurface'
> {
  return {
    focusTerminalTabSurface: mocks.focusTerminalTabSurface
  }
}

export function createOrchestrationSetupStateModule(): {
  ORCHESTRATION_SETUP_DISMISSED_STORAGE_KEY: string
  ORCHESTRATION_SETUP_STATE_EVENT: string
  hasOrchestrationSetupMarker: Mock<() => boolean>
  isOrchestrationSetupDismissed: Mock<() => boolean>
  notifyOrchestrationSetupStateChanged: Mock<() => void>
} {
  return {
    ORCHESTRATION_SETUP_DISMISSED_STORAGE_KEY: 'floating-terminal-test-dismissed',
    ORCHESTRATION_SETUP_STATE_EVENT: 'floating-terminal-test-setup-state',
    hasOrchestrationSetupMarker: vi.fn(() => true),
    isOrchestrationSetupDismissed: vi.fn(() => false),
    notifyOrchestrationSetupStateChanged: vi.fn()
  }
}
