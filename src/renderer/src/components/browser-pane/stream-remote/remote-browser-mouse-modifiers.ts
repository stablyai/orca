import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { readRuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import { lastVerifiedRuntimeStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RemoteBrowserRuntimeTarget } from './remote-browser-page-input-model'

type RemoteBrowserMouseModifier = 'cmd' | 'ctrl' | 'alt' | 'shift'
type ModifierKeys = Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

/**
 * A press's modifiers as the host's Chromium reads them. Cmd (macOS) and Ctrl (elsewhere) swap
 * when the two machines differ, so a new-tab click stays one on the host.
 */
export function getRemoteBrowserMouseModifiers(
  event: ModifierKeys,
  platforms: { clientMac: boolean; hostMac: boolean | null }
): RemoteBrowserMouseModifier[] | undefined {
  const swap = platforms.hostMac !== null && platforms.hostMac !== platforms.clientMac
  const modifiers: RemoteBrowserMouseModifier[] = []
  if (swap ? event.ctrlKey : event.metaKey) {
    modifiers.push('cmd')
  }
  if (swap ? event.metaKey : event.ctrlKey) {
    modifiers.push('ctrl')
  }
  if (event.altKey) {
    modifiers.push('alt')
  }
  if (event.shiftKey) {
    modifiers.push('shift')
  }
  return modifiers.length > 0 ? modifiers : undefined
}

export function readRemoteBrowserMouseModifiers(
  event: ModifierKeys,
  target: RemoteBrowserRuntimeTarget
): RemoteBrowserMouseModifier[] | undefined {
  // Older servers report no platform; their modifiers go through as pressed.
  const hostPlatform = lastVerifiedRuntimeStatus(
    readRuntimeStatuses().get(target.environmentId)
  )?.hostPlatform
  return getRemoteBrowserMouseModifiers(event, {
    clientMac: getShortcutPlatform() === 'darwin',
    hostMac: hostPlatform ? hostPlatform === 'darwin' : null
  })
}

/** macOS Control+click is a right click, as it is in a local page. */
export function isMacControlClick(event: Pick<MouseEvent, 'button' | 'ctrlKey'>): boolean {
  return event.button === 0 && event.ctrlKey && getShortcutPlatform() === 'darwin'
}
