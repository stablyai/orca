import { isMacPlatform } from './terminal-link-open-hints'

export function isTerminalLinkActivation(
  event: Pick<MouseEvent, 'metaKey' | 'ctrlKey'> | undefined
): boolean {
  return isMacPlatform() ? Boolean(event?.metaKey) : Boolean(event?.ctrlKey)
}
