import { closeSync as fsCloseSync, openSync as fsOpenSync } from 'node:fs'

export const WINDOWS_CONSOLE_INPUT_DEVICE = '\\\\.\\CONIN$'

export type WindowsConsoleInput = {
  fd: number
  dispose: () => void
}

type OpenWindowsConsoleInputDeps = {
  platform?: NodeJS.Platform
  openSync?: (path: string, flags: string) => number
  closeSync?: (fd: number) => void
}

type WindowsInteractiveChildStdio = [
  number | 'inherit',
  typeof process.stderr | 'inherit',
  'inherit'
]

/** Opens the real Windows console input device instead of Electron's inherited stdin. */
export function openWindowsConsoleInput(
  deps: OpenWindowsConsoleInputDeps = {}
): WindowsConsoleInput | 'inherit' {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') {
    return 'inherit'
  }
  const openSync = deps.openSync ?? ((path: string, flags: string) => fsOpenSync(path, flags))
  const closeSync = deps.closeSync ?? fsCloseSync
  try {
    const fd = openSync(WINDOWS_CONSOLE_INPUT_DEVICE, 'r+')
    let disposed = false
    return {
      fd,
      dispose: () => {
        if (disposed) {
          return
        }
        disposed = true
        try {
          closeSync(fd)
        } catch {
          // Descriptor ownership may already have transferred during spawn.
        }
      }
    }
  } catch {
    return 'inherit'
  }
}

export function stdioForWindowsInteractiveChild(
  json: boolean,
  deps: OpenWindowsConsoleInputDeps = {}
): { stdio: WindowsInteractiveChildStdio; dispose: () => void } {
  const opened = openWindowsConsoleInput(deps)
  return opened === 'inherit'
    ? {
        stdio: ['inherit', json ? process.stderr : 'inherit', 'inherit'],
        dispose: () => {}
      }
    : {
        stdio: [opened.fd, json ? process.stderr : 'inherit', 'inherit'],
        dispose: opened.dispose
      }
}
