import { useEffect, useState, type RefObject } from 'react'
import {
  NATIVE_CHAT_VISUAL_THEME_TOKENS,
  type NativeChatVisualTheme
} from '../../../../shared/native-chat-visual-shell'

// The visual blends into the thread: its background and text follow the chat column, which a
// chat's own appearance can set apart from the app root.
const SCOPED_SOURCES: Partial<Record<string, readonly string[]>> = {
  '--background': ['--chat-canvas', '--background'],
  '--foreground': ['--chat-foreground', '--foreground'],
  '--font-mono': ['--chat-code-font-family', '--font-mono']
}

/** The resolved theme at `element`, read from computed styles in its own appearance scope. */
export function readNativeChatVisualTheme(element: Element | null): NativeChatVisualTheme {
  const source = element ?? document.documentElement
  const styles = getComputedStyle(source)
  const tokens: Record<string, string> = {}
  for (const token of NATIVE_CHAT_VISUAL_THEME_TOKENS) {
    if (token === '--font-sans') {
      tokens[token] = styles.fontFamily
      continue
    }
    for (const name of SCOPED_SOURCES[token] ?? [token]) {
      const value = styles.getPropertyValue(name).trim()
      if (value.length > 0) {
        tokens[token] = value
        break
      }
    }
  }
  return { colorScheme: resolvedColorScheme(element), tokens }
}

/** A chat can pin its own scheme apart from the app's (see the `dark` variant in main.css). */
function resolvedColorScheme(element: Element | null): 'light' | 'dark' {
  const pinned = element
    ?.closest('[data-native-chat-scheme]')
    ?.getAttribute('data-native-chat-scheme')
  if (pinned === 'light' || pinned === 'dark') {
    return pinned
  }
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

function themeSnapshot(theme: NativeChatVisualTheme): string {
  return JSON.stringify(theme)
}

/**
 * The theme a visual should wear, updated when the app theme or the chat's appearance changes.
 * Compares resolved values, so unrelated style writes (a sidebar drag) never produce a new theme.
 */
export function useNativeChatVisualTheme(
  elementRef: RefObject<Element | null>
): NativeChatVisualTheme {
  const [theme, setTheme] = useState<NativeChatVisualTheme>(() =>
    readNativeChatVisualTheme(elementRef.current)
  )
  useEffect(() => {
    let snapshot = ''
    const refresh = (): void => {
      const next = readNativeChatVisualTheme(elementRef.current)
      const nextSnapshot = themeSnapshot(next)
      if (nextSnapshot !== snapshot) {
        snapshot = nextSnapshot
        setTheme(next)
      }
    }
    refresh()
    const observer = new MutationObserver(refresh)
    const watched = new Set<Element>([document.documentElement])
    for (const selector of ['.native-chat-appearance', '[data-native-chat-scheme]']) {
      const scope = elementRef.current?.closest(selector)
      if (scope) {
        watched.add(scope)
      }
    }
    for (const element of watched) {
      observer.observe(element, {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-native-chat-scheme']
      })
    }
    return () => observer.disconnect()
  }, [elementRef])
  return theme
}
