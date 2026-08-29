type TauriWindowHandle = {
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<void>
  isMaximized: () => Promise<boolean>
  close: () => Promise<void>
  onResized: (handler: () => void) => Promise<() => void>
}

async function currentTauriWindow(): Promise<TauriWindowHandle | null> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    return getCurrentWindow()
  } catch {
    return null
  }
}

export function createDesktopWindowControls(): {
  minimize: () => void
  maximize: () => void
  requestClose: () => void
  isMaximized: () => Promise<boolean>
  onMaximizeChanged: (callback: (maximized: boolean) => void) => () => void
} {
  const listeners = new Set<(maximized: boolean) => void>()
  let unsubscribeResize: (() => void) | null = null

  const publishMaximized = async (): Promise<void> => {
    const windowHandle = await currentTauriWindow()
    const maximized = windowHandle ? await windowHandle.isMaximized() : false
    for (const listener of listeners) {
      listener(maximized)
    }
  }

  return {
    minimize: () => {
      void currentTauriWindow().then((windowHandle) => windowHandle?.minimize())
    },
    maximize: () => {
      void currentTauriWindow().then((windowHandle) => windowHandle?.toggleMaximize())
    },
    requestClose: () => {
      void currentTauriWindow().then((windowHandle) => windowHandle?.close())
    },
    isMaximized: async () => {
      const windowHandle = await currentTauriWindow()
      return windowHandle ? windowHandle.isMaximized() : false
    },
    onMaximizeChanged: (callback) => {
      listeners.add(callback)
      if (!unsubscribeResize) {
        void currentTauriWindow().then(async (windowHandle) => {
          if (!windowHandle) {
            return
          }
          unsubscribeResize = await windowHandle.onResized(() => {
            void publishMaximized()
          })
        })
      }
      return () => {
        listeners.delete(callback)
      }
    }
  }
}
