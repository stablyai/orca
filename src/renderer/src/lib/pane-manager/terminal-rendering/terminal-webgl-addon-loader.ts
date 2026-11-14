import type { WebglAddon } from '@xterm/addon-webgl'
import { createLazyXtermAddonLoader } from './terminal-lazy-addon-loader'

// Keep the addon off boot-critical imports; prime after React root render, then attachWebgl reads its resolved constructor synchronously.
const loader = createLazyXtermAddonLoader<new () => WebglAddon>({
  load: () => import('@xterm/addon-webgl').then((module) => module.WebglAddon),
  failureMessage: '[terminal] WebGL addon failed to load — using DOM renderer:'
})

type TerminalWebglAddonLoadHandlers = {
  onLoaded: () => void
  onFailed: () => void
}

export function setTerminalWebglAddonLoadHandlers(next: TerminalWebglAddonLoadHandlers): void {
  loader.setHandlers(next)
}

export function getTerminalWebglAddonConstructor(): (new () => WebglAddon) | null {
  return loader.getConstructor()
}

export function primeTerminalWebglAddon(): Promise<void> {
  return loader.prime()
}

/** Recovery boundary (GPU setting changed): let a failed load try again. */
export function rearmTerminalWebglAddonLoad(): void {
  loader.rearm()
}
