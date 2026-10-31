import type { ImageAddon, IImageAddonOptions } from '@xterm/addon-image'
import { createLazyXtermAddonLoader } from './terminal-lazy-addon-loader'

// Defer bundled wasm decoders/protocol handlers until inline images are enabled; later panes reuse the loaded constructor synchronously.
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

/** A user toggle allows another bounded load attempt. */
export function rearmTerminalImageAddonLoad(): void {
  loader.rearm()
}
