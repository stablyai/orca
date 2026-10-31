import type { Terminal } from '@xterm/xterm'
import { getTerminalWebglAddonConstructor } from '@/lib/pane-manager/terminal-webgl-addon-loader'
import { releaseXtermWebglContext } from '@/lib/pane-manager/pane-webgl-renderer'

export function attachCopyModeRenderer(
  terminal: Terminal,
  useWebgl: boolean,
  onContextLoss: () => void
): () => void {
  // Identical font options still produce different glyph placement in DOM and WebGL.
  if (!useWebgl) {
    return () => {}
  }
  const Constructor = getTerminalWebglAddonConstructor()
  if (!Constructor) {
    throw new Error('The source terminal renderer is unavailable')
  }
  const addon = new Constructor()
  const loss = addon.onContextLoss(onContextLoss)
  let disposed = false
  const dispose = (): void => {
    if (disposed) {
      return
    }
    disposed = true
    loss.dispose()
    releaseXtermWebglContext(addon)
    addon.dispose()
  }
  try {
    terminal.loadAddon(addon)
    return dispose
  } catch (error) {
    dispose()
    throw error
  }
}
