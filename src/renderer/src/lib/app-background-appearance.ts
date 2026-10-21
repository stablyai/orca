import type { CSSProperties } from 'react'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  normalizeAppBackgroundBlur,
  normalizeAppBackgroundImageId,
  normalizeAppBackgroundImageOpacity,
  normalizeAppBackgroundPanelOpacity,
  normalizeAppBackgroundScope,
  type AppBackgroundScope
} from '../../../shared/app-background-settings'

/** Host attribute; its value is the scope. main.css keys every panel override off it. */
export const APP_BACKGROUND_ATTRIBUTE = 'data-app-background'
/** Marker for panels that turn translucent inside a host; value names the token to fade. */
export const APP_BACKGROUND_SURFACE_ATTRIBUTE = 'data-app-background-surface'
/** Unitless 0..1 panel opacity set inline on the host. */
export const APP_PANEL_OPACITY_VAR = '--app-panel-opacity'

export type AppBackgroundSurface = 'card' | 'sidebar' | 'worktree-sidebar'

export type AppBackgroundAppearance = {
  imageId: string
  scope: AppBackgroundScope
  imageOpacity: number
  blur: number
  panelOpacity: number
}

export type AppBackgroundHostStyle = CSSProperties & Record<typeof APP_PANEL_OPACITY_VAR, string>

export type AppBackgroundHostProps = {
  [APP_BACKGROUND_ATTRIBUTE]: AppBackgroundScope
  style: AppBackgroundHostStyle
}

type AppBackgroundSettings = Pick<
  GlobalSettings,
  | 'appBackgroundImageId'
  | 'appBackgroundScope'
  | 'appBackgroundImageOpacity'
  | 'appBackgroundBlur'
  | 'appBackgroundPanelOpacity'
>

/** Null unless a saved image exists on a desktop client; null means "render exactly as before". */
export function resolveAppBackgroundAppearance(
  settings: AppBackgroundSettings | null | undefined,
  isWebClient: boolean
): AppBackgroundAppearance | null {
  const imageId = normalizeAppBackgroundImageId(settings?.appBackgroundImageId)
  if (!imageId || isWebClient) {
    return null
  }
  return {
    imageId,
    scope: normalizeAppBackgroundScope(settings?.appBackgroundScope),
    imageOpacity: normalizeAppBackgroundImageOpacity(settings?.appBackgroundImageOpacity),
    blur: normalizeAppBackgroundBlur(settings?.appBackgroundBlur),
    panelOpacity: normalizeAppBackgroundPanelOpacity(settings?.appBackgroundPanelOpacity)
  }
}

/** Props for any element that should host the background (app root, workspace, or a preview frame). */
export function getAppBackgroundHostProps(
  scope: AppBackgroundScope,
  panelOpacity: number
): AppBackgroundHostProps {
  return {
    [APP_BACKGROUND_ATTRIBUTE]: scope,
    style: { [APP_PANEL_OPACITY_VAR]: String(normalizeAppBackgroundPanelOpacity(panelOpacity)) }
  }
}

/** Pane titles mirror the xterm surface (theme bg at terminal opacity) so they stay one panel over the image. */
export function resolveTranslucentPaneTitleBackground(
  terminalBackground: string | undefined,
  terminalBackgroundOpacity: number | undefined
): string | null {
  if (!terminalBackground) {
    return null
  }
  const opacity =
    typeof terminalBackgroundOpacity === 'number' && Number.isFinite(terminalBackgroundOpacity)
      ? Math.min(1, Math.max(0, terminalBackgroundOpacity))
      : 1
  if (opacity >= 1) {
    return null
  }
  return `color-mix(in srgb, ${terminalBackground} ${Math.round(opacity * 100)}%, transparent)`
}
