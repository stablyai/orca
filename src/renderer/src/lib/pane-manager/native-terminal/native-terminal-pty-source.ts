import type { NativeTerminalMirror } from './native-terminal-mirror'

type NativeTerminalSourcePane = {
  surfaceId: number | null
  ptyId: string
  disposed: boolean
  host: { serialize: () => string }
}

// Main feeds a surface straight from the PTY stream when its bytes pass through main; the
// renderer mirror is the fallback (paired remote runtimes, or main declining).
export async function connectNativeTerminalSource(
  api: Window['api']['nativeTerminal'],
  pane: NativeTerminalSourcePane,
  mirror: NativeTerminalMirror,
  reset: boolean
): Promise<void> {
  const { surfaceId, ptyId } = pane
  if (surfaceId === null) {
    return
  }
  // Why first: while main answers, forwarding from here could duplicate bytes main sends too.
  mirror.followMain(surfaceId)
  const fedByMain = await api.bindPty(surfaceId, ptyId).catch(() => false)
  if (pane.disposed || pane.surfaceId !== surfaceId || pane.ptyId !== ptyId || fedByMain) {
    return
  }
  // The renderer seed covers everything the mirror skipped while main answered.
  mirror.attach(surfaceId, () => pane.host.serialize(), reset)
}
