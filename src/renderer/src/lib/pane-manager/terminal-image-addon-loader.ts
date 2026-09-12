import type { ImageAddon, IImageAddonOptions } from '@xterm/addon-image'
import { createLazyXtermAddonLoader } from './terminal-lazy-addon-loader'

// Why deferred: @xterm/addon-image ships the SIXEL/QOI/base64 wasm decoders
// inlined as base64 plus the protocol handlers — a chunk no idle terminal needs.
// Panes only ever construct it once a terminal attaches with inline images
// enabled. Later panes reuse the loaded constructor synchronously.
type ImageAddonConstructor = new (options?: IImageAddonOptions) => ImageAddon

const loader = createLazyXtermAddonLoader<ImageAddonConstructor>({
  load: () => import('@xterm/addon-image').then((module) => module.ImageAddon),
  failureMessage: '[terminal] image addon failed to load — inline images disabled:'
})

type TerminalImageAddonLoadHandlers = {
  onLoaded: () => void
}

export function setTerminalImageAddonLoadHandlers(next: TerminalImageAddonLoadHandlers): void {
  loader.setHandlers(next)
}

export function getTerminalImageAddonConstructor(): ImageAddonConstructor | null {
  return loader.getConstructor()
}

export function primeTerminalImageAddon(): Promise<void> {
  return loader.prime()
}
