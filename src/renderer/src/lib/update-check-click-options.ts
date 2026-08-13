import type { UpdateCheckOptions } from '../../../shared/types'
import { translate } from '@/i18n/i18n'
import { getShortcutPlatform } from './shortcut-platform'

type UpdateCheckClickEvent = Pick<MouseEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>

/** Which button the gesture is attached to; the two surfaces honour different modifiers. */
export type UpdateCheckSurface = 'app' | 'remote-server'

type UpdateCheckGesture = {
  surfaces: readonly UpdateCheckSurface[]
  isPressed: (event: UpdateCheckClickEvent, isMac: boolean) => boolean
  modifierLabel: (isMac: boolean) => string
}

// Single source of truth for gesture -> channel: both the resolved UpdateCheckOptions and the
// user-facing hints are derived from this table, so advertised copy cannot drift from behavior.
const UPDATE_CHECK_GESTURES: Record<'rc' | 'perf' | 'localBuild', UpdateCheckGesture> = {
  rc: {
    surfaces: ['app', 'remote-server'],
    isPressed: (event) => event.shiftKey,
    modifierLabel: (isMac) => (isMac ? '⇧' : 'Shift')
  },
  perf: {
    surfaces: ['app', 'remote-server'],
    isPressed: (event, isMac) => (isMac ? event.metaKey : event.ctrlKey),
    modifierLabel: (isMac) => (isMac ? '⌘' : 'Ctrl')
  },
  // Why: refreshRemoteServerUpdates() forwards only the prerelease flags, and a paired Linux
  // server has no macOS build to pick anyway — so ⌥ is a no-op on the remote-server surface.
  localBuild: {
    surfaces: ['app'],
    isPressed: (event, isMac) => isMac && event.altKey,
    modifierLabel: () => '⌥'
  }
}

function isMacShortcutPlatform(): boolean {
  return getShortcutPlatform() === 'darwin'
}

function supportsGesture(gesture: UpdateCheckGesture, surface: UpdateCheckSurface): boolean {
  return gesture.surfaces.includes(surface)
}

function buildUpdateCheckHint(surface: UpdateCheckSurface, isMac: boolean): string {
  const value0 = UPDATE_CHECK_GESTURES.rc.modifierLabel(isMac)
  const value1 = UPDATE_CHECK_GESTURES.perf.modifierLabel(isMac)
  if (surface === 'remote-server') {
    return translate(
      'auto.lib.updateCheckClickOptions.serverHint',
      '{{value0}}+click checks servers for the latest RC; {{value1}}+click checks servers for the latest perf build.',
      { value0, value1 }
    )
  }
  const channelHint = translate(
    'auto.lib.updateCheckClickOptions.hint',
    '{{value0}}+click checks the latest RC; {{value1}}+click checks the latest perf build.',
    { value0, value1 }
  )
  if (!isMac || !supportsGesture(UPDATE_CHECK_GESTURES.localBuild, surface)) {
    return channelHint
  }
  const localBuildHint = translate(
    'auto.lib.updateCheckClickOptions.localBuildHint',
    '{{value0}}+click chooses a local macOS build.',
    { value0: UPDATE_CHECK_GESTURES.localBuild.modifierLabel(isMac) }
  )
  return `${channelHint} ${localBuildHint}`
}

export function getUpdateCheckHint(isMac = isMacShortcutPlatform()): string {
  return buildUpdateCheckHint('app', isMac)
}

export function getRemoteServerUpdateCheckHint(isMac = isMacShortcutPlatform()): string {
  return buildUpdateCheckHint('remote-server', isMac)
}

/** Compact variant for the width-constrained help dropdown; the full sentence does not fit. */
export function getUpdateCheckMenuHint(isMac = isMacShortcutPlatform()): string {
  return translate(
    'auto.lib.updateCheckClickOptions.menuHint',
    '{{value0}}+click RC · {{value1}}+click perf',
    {
      value0: UPDATE_CHECK_GESTURES.rc.modifierLabel(isMac),
      value1: UPDATE_CHECK_GESTURES.perf.modifierLabel(isMac)
    }
  )
}

function resolveUpdateCheckOptions(
  event: UpdateCheckClickEvent,
  isMac: boolean,
  surface: UpdateCheckSurface
): UpdateCheckOptions {
  const localBuild = UPDATE_CHECK_GESTURES.localBuild
  if (supportsGesture(localBuild, surface) && localBuild.isPressed(event, isMac)) {
    return { localBuild: true }
  }
  return {
    includePrerelease: UPDATE_CHECK_GESTURES.rc.isPressed(event, isMac),
    includePerfPrerelease: UPDATE_CHECK_GESTURES.perf.isPressed(event, isMac)
  }
}

export function getUpdateCheckClickOptions(
  event: UpdateCheckClickEvent,
  isMac = isMacShortcutPlatform()
): UpdateCheckOptions {
  return resolveUpdateCheckOptions(event, isMac, 'app')
}

export function getRemoteServerUpdateCheckClickOptions(
  event: UpdateCheckClickEvent,
  isMac = isMacShortcutPlatform()
): UpdateCheckOptions {
  return resolveUpdateCheckOptions(event, isMac, 'remote-server')
}
