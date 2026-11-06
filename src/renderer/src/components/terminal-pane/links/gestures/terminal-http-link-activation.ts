import { isTerminalLinkDirectActivation } from './terminal-link-activation'

export function isTerminalHttpLinkActivation(event: MouseEvent | undefined): boolean {
  return isTerminalLinkDirectActivation(event)
}
