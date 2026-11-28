import type { TerminalLigaturesAddon } from './terminal-ligatures-addon'
import { createLazyXtermAddonLoader } from './terminal-lazy-addon-loader'

// Defer @xterm/addon-ligatures (~275 KiB) until ligatures are enabled; later panes reuse the loaded constructor synchronously.
type TerminalLigaturesAddonConstructor = new () => TerminalLigaturesAddon

const loader = createLazyXtermAddonLoader<TerminalLigaturesAddonConstructor>({
  load: () => import('./terminal-ligatures-addon').then((module) => module.TerminalLigaturesAddon),
  failureMessage: '[terminal] ligatures addon failed to load — ligatures disabled:'
})

type TerminalLigaturesAddonLoadHandlers = {
  onLoaded: () => void
}

export function setTerminalLigaturesAddonLoadHandlers(
  next: TerminalLigaturesAddonLoadHandlers
): void {
  loader.setHandlers(next)
}

export function getTerminalLigaturesAddonConstructor(): TerminalLigaturesAddonConstructor | null {
  return loader.getConstructor()
}

export function primeTerminalLigaturesAddon(): Promise<void> {
  return loader.prime()
}

/** A user toggle allows another bounded load attempt. */
export function rearmTerminalLigaturesAddonLoad(): void {
  loader.rearm()
}
