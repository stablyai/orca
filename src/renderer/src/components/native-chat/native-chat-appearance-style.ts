import './native-chat-appearance.css'
import { useMemo, type CSSProperties } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { resolveNativeChatAppearanceSettings } from '../../../../shared/native-chat-appearance-settings'
import { resolveConfiguredTerminalColors } from '../../../../shared/terminal-theme-selection'
import { buildFontFamily } from '@/lib/monospace-font-family'
import { getSystemPrefersDark, isTerminalBackgroundLight } from '@/lib/terminal-theme'
import { useSystemPrefersDark } from '../terminal-pane/use-system-prefers-dark'

export const NATIVE_CHAT_APPEARANCE_ROOT_CLASS = 'native-chat-appearance bg-chat-canvas'
export const NATIVE_CHAT_TRANSCRIPT_OUTER_CLASS = 'px-3 pt-10 pb-4 sm:px-4'
export const NATIVE_CHAT_TRANSCRIPT_COLUMN_CLASS =
  'mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-5 px-[5px]'

export type NativeChatAppearanceStyle = CSSProperties &
  Record<`--${string}`, string | number> & {
    '--chat-font-size': string
    '--chat-code-font-size': string
    '--chat-content-max-width': string
    '--chat-inline-code-ratio': string
    '--chat-estimated-line-height': number
    '--chat-estimated-chars-per-line': number
  }

// Width buckets keep a pixel-by-pixel resize from re-deriving the entire transcript.
export function nativeChatColumnWidthBucket(width: number | null | undefined): number | null {
  return typeof width === 'number' && Number.isFinite(width) && width > 0
    ? Math.max(1, Math.floor(width / 32) * 32)
    : null
}

export function selectNativeChatAppearanceSettings(
  settings: Partial<GlobalSettings> | null | undefined
) {
  return {
    theme: settings?.theme,
    terminalThemeDark: settings?.terminalThemeDark,
    terminalThemeLight: settings?.terminalThemeLight,
    terminalUseSeparateLightTheme: settings?.terminalUseSeparateLightTheme,
    terminalCustomThemes: settings?.terminalCustomThemes,
    terminalColorOverrides: settings?.terminalColorOverrides,
    terminalFontFamily: settings?.terminalFontFamily,
    terminalFontSize: settings?.nativeChatAppearance?.matchTerminalInterface
      ? settings.terminalFontSize
      : undefined,
    nativeChatAppearance: settings?.nativeChatAppearance
  }
}

export function nativeChatContrastMix(contrast: number, light: boolean): number {
  const value = Number.isFinite(contrast) ? Math.min(150, Math.max(50, contrast)) : 100
  return light
    ? Math.min(100, Math.max(55, 82 + (value - 100) * 0.36))
    : Math.min(100, Math.max(50, 78 + (value - 100) * 0.44))
}

export function nativeChatAppearanceStyle(
  settings: Partial<GlobalSettings> | null | undefined,
  measuredColumnWidthPx?: number | null,
  systemPrefersDark = getSystemPrefersDark()
): NativeChatAppearanceStyle {
  const appearance = resolveNativeChatAppearanceSettings(settings?.nativeChatAppearance)
  const { width } = appearance
  const matching = appearance.matchTerminalInterface
  const terminalFontSize = settings?.terminalFontSize ?? 14
  const fontSize = matching ? terminalFontSize : appearance.fontSize
  const codeFontSize = matching ? terminalFontSize : appearance.codeFontSize
  const maxWidthPx = width === 'wide' ? 960 : width === 'full' ? Number.POSITIVE_INFINITY : 736
  const measuredWidth = nativeChatColumnWidthBucket(measuredColumnWidthPx)
  const columnWidthPx = Math.min(
    measuredWidth ? measuredWidth : width === 'wide' ? 960 : 736,
    maxWidthPx
  )
  const font = buildFontFamily(settings?.terminalFontFamily ?? '')
  const style: NativeChatAppearanceStyle = {
    '--chat-font-size': `${fontSize}px`,
    '--chat-code-font-size': `${codeFontSize}px`,
    '--chat-content-max-width': width === 'full' ? 'none' : width === 'wide' ? '60rem' : '46rem',
    '--chat-inline-code-ratio': `${codeFontSize / fontSize}em`,
    '--chat-estimated-line-height': (22 * fontSize) / 14,
    '--chat-estimated-chars-per-line': Math.max(
      1,
      Math.floor((((96 * columnWidthPx) / 736) * 14) / fontSize)
    ),
    '--chat-code-font-family': font
  }
  let light = settings?.theme === 'light' || (settings?.theme === 'system' && !systemPrefersDark)
  if (matching) {
    const colors = resolveConfiguredTerminalColors(
      {
        theme: settings?.theme ?? 'dark',
        terminalThemeDark: settings?.terminalThemeDark ?? '',
        terminalThemeLight: settings?.terminalThemeLight ?? '',
        terminalUseSeparateLightTheme: settings?.terminalUseSeparateLightTheme ?? false,
        terminalCustomThemes: settings?.terminalCustomThemes,
        terminalColorOverrides: settings?.terminalColorOverrides
      },
      systemPrefersDark
    )
    const hasThemeColors = Boolean(colors.background && colors.foreground)
    const background = hasThemeColors ? colors.background : '#000000'
    const foreground = hasThemeColors ? colors.foreground : '#fafafa'
    light = isTerminalBackgroundLight(background)
    style.colorScheme = light ? 'light' : 'dark'
    // Ghost controls inherit a color, so remapping the token alone leaves the app's color in place.
    style.color = 'var(--foreground)'
    Object.assign(style, {
      '--chat-font-family': font,
      '--background': 'var(--chat-canvas)',
      '--foreground': 'var(--chat-foreground-strong)',
      '--muted-foreground': 'var(--chat-source-muted-foreground)',
      '--accent': 'color-mix(in srgb, var(--chat-source-foreground) 9%, var(--chat-canvas))',
      '--muted': 'color-mix(in srgb, var(--chat-source-foreground) 7%, var(--chat-canvas))',
      '--popover': 'color-mix(in srgb, var(--chat-source-foreground) 4%, var(--chat-canvas))',
      '--popover-foreground': 'var(--chat-foreground-strong)',
      '--accent-foreground': 'var(--chat-foreground-strong)',
      '--border': 'color-mix(in srgb, var(--chat-source-foreground) 7%, var(--chat-canvas))',
      '--input': 'color-mix(in srgb, var(--chat-source-foreground) 7%, var(--chat-canvas))',
      '--card': 'color-mix(in srgb, var(--chat-source-foreground) 4%, var(--chat-canvas))',
      '--card-foreground': 'var(--chat-foreground-strong)',
      '--primary': 'var(--chat-foreground-strong)',
      '--primary-foreground': 'var(--chat-canvas)',
      '--secondary': 'var(--muted)',
      '--secondary-foreground': 'var(--chat-foreground-strong)',
      '--ring': 'color-mix(in srgb, var(--chat-source-foreground) 44%, var(--chat-canvas))',
      '--chat-source-background': background,
      '--chat-source-foreground': foreground,
      '--chat-source-muted-foreground':
        'color-mix(in srgb, var(--chat-source-foreground) 62%, var(--chat-canvas))',
      '--chat-canvas-mix': '0%',
      '--chat-faint-mix': light ? '100%' : '83%',
      '--chat-user-mix': light ? '4%' : '7%',
      '--chat-user-border-mix': light ? '7%' : '6%',
      '--chat-code-mix': light ? '2%' : '3.5%',
      '--chat-code-base': light ? 'var(--chat-canvas)' : 'transparent',
      '--chat-inline-code-mix': light ? '4%' : '6%',
      '--chat-inline-code-base': light ? 'var(--chat-canvas)' : 'transparent',
      '--chat-inline-code-border-mix': light ? '9%' : '8%',
      '--chat-composer-mix': light ? '0%' : '4%',
      '--chat-composer-base': light ? 'var(--chat-canvas)' : 'transparent',
      '--chat-composer-border-mix': light ? '11%' : '9%'
    })
  }
  const bodyMix = matching ? 100 : nativeChatContrastMix(appearance.contrast, light)
  style['--chat-foreground-mix'] = `${bodyMix}%`
  style['--chat-strong-mix'] = `${Math.min(100, bodyMix + (light ? 10 : 12))}%`
  return style
}

export function useNativeChatAppearanceStyle(
  settings: Partial<GlobalSettings> | null | undefined,
  measuredColumnWidthPx?: number | null
): NativeChatAppearanceStyle {
  const selectInputs = useShallow(selectNativeChatAppearanceSettings)
  const inputs = selectInputs(settings)
  const systemPrefersDark = useSystemPrefersDark()
  const measuredWidth = nativeChatColumnWidthBucket(measuredColumnWidthPx)
  return useMemo(
    () => nativeChatAppearanceStyle(inputs, measuredWidth, systemPrefersDark),
    [inputs, measuredWidth, systemPrefersDark]
  )
}
