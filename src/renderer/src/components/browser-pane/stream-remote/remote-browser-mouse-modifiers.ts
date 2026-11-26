import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { readRuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import { runtimeHostPlatform } from '@/components/terminal-pane/pty-transport/host-ownership/pty-owner-machine-platform'
import type { BrowserMouseModifier } from '../../../../../shared/rpc-contract/browser/browser-params'
import type { RemoteBrowserRuntimeTarget } from './remote-browser-page-input-model'

/**
 * A press's modifiers as the host's Chromium reads them. Cmd (macOS) and Ctrl (elsewhere) swap
 * when the two machines differ, so a new-tab click stays one on the host. Older servers report
 * no platform; their modifiers go through as pressed.
 */
export function readRemoteBrowserMouseModifiers(
  event: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  target: RemoteBrowserRuntimeTarget
): BrowserMouseModifier[] | undefined {
  const hostPlatform = runtimeHostPlatform(readRuntimeStatuses(), target.environmentId)
  const swap = hostPlatform !== null && (hostPlatform === 'darwin') !== isMacClient()
  const modifiers: BrowserMouseModifier[] = []
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

/** macOS Control+click is a right click, as it is in a local page. */
export function isMacControlClick(event: Pick<MouseEvent, 'button' | 'ctrlKey'>): boolean {
  return event.button === 0 && event.ctrlKey && isMacClient()
}

function isMacClient(): boolean {
  return getShortcutPlatform() === 'darwin'
}
