import { resolveZoomShortcut } from '../../../../shared/keybindings/window-shortcut-policy'
import { changeRegionZoom } from '@/app-shell/chrome/region-zoom'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { publishWebContextualZoom } from '@/web/preload-api/preferences/web-contextual-zoom'
import { shortcutPlatform } from '@/app-shell/chrome/app-window-chrome'
import {
  getKeybindingContext,
  type AppShortcutState
} from '@/lib/app-commands/app-command-handlers'
import type { PhysicalModifierToken } from '../../../../shared/keybindings/types'
import { textInputOwnsComposition } from '../../../../shared/keybindings/text-input-shortcut-policy'

export function handleWebZoomShortcut(
  event: KeyboardEvent,
  modifier: PhysicalModifierToken | undefined,
  {
    keybindings,
    terminalShortcutPolicy
  }: Pick<AppShortcutState, 'keybindings' | 'terminalShortcutPolicy'>
): boolean {
  if (
    !isWebClientLocation() ||
    event.defaultPrevented ||
    textInputOwnsComposition(event) ||
    (event.target instanceof Element && event.target.closest('[data-shortcut-recorder-active]'))
  ) {
    return false
  }
  const zoom = resolveZoomShortcut(
    modifier ? { doubleTapModifier: modifier } : event,
    shortcutPlatform,
    keybindings,
    {
      context: getKeybindingContext(event.target),
      terminalShortcutPolicy
    }
  )
  if (!zoom) {
    return false
  }
  event.preventDefault()
  event.stopImmediatePropagation()
  if (zoom.region) {
    changeRegionZoom(zoom.region, zoom.direction)
  } else {
    publishWebContextualZoom(zoom.direction)
  }
  return true
}
