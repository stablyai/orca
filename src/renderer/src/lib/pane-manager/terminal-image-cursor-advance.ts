import type { Terminal, IDisposable } from '@xterm/xterm'
import type { ImageAddon } from '@xterm/addon-image'

// Narrow cast for the xterm _core internals we touch.
type TerminalWithCore = {
  _core?: {
    buffer?: { x: number }
    _inputHandler?: { lineFeed: () => void }
  }
}

/**
 * After any inline image (IIP, SIXEL, Kitty), advance the text cursor to
 * column 0 of the next row so that subsequent shell output starts below the
 * picture instead of beside or on top of it.
 *
 * Why this is needed: `@xterm/addon-image` follows each protocol's native
 * cursor-placement spec — IIP/Kitty leave the cursor at the bottom-right of
 * the image, SIXEL/VT340 at the bottom-left. Both positions are still *on*
 * the last image row, so the next prompt/output collides with the picture.
 * Programs like `imgcat` work around this by appending their own `\n`, but
 * raw OSC 1337 / APC G / DCS q sequences do not.
 */
export function attachImageCursorAdvance(terminal: Terminal, imageAddon: ImageAddon): IDisposable {
  return imageAddon.onImageAdded(() => {
    const core = (terminal as unknown as TerminalWithCore)._core
    core?._inputHandler?.lineFeed()
    if (core?.buffer) {
      core.buffer.x = 0
    }
  })
}
