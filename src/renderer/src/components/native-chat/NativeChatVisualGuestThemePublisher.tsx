import { useEffect } from 'react'
import { useAppStore } from '@/store'
import {
  nativeChatAppearanceStyle,
  NATIVE_CHAT_APPEARANCE_ROOT_CLASS
} from './native-chat-appearance-style'
import { useNativeChatStoreAppearanceStyle } from './use-native-chat-store-appearance-style'
import { readNativeChatVisualTheme } from './use-native-chat-visual-theme'

let published: string | null = null

/** Resolve the same chat scope even when Open or session restore has no mounted transcript. */
export function publishNativeChatVisualGuestTheme(): void {
  const publish = window.api?.nativeChat?.publishVisualGuestTheme
  if (!publish) {
    return
  }
  const style = nativeChatAppearanceStyle(useAppStore.getState().settings)
  const probe = document.createElement('div')
  probe.hidden = true
  probe.className = NATIVE_CHAT_APPEARANCE_ROOT_CLASS
  for (const [name, value] of Object.entries(style)) {
    if (name.startsWith('--')) {
      probe.style.setProperty(name, String(value))
    }
  }
  if (style.color) {
    probe.style.color = style.color
  }
  if (style.colorScheme) {
    probe.style.colorScheme = style.colorScheme
    probe.dataset.nativeChatScheme = style.colorScheme
  }
  document.body.appendChild(probe)
  const theme = readNativeChatVisualTheme(probe)
  probe.remove()
  const snapshot = JSON.stringify(theme)
  if (snapshot !== published) {
    publish(theme)
    published = snapshot
  }
}

/** One subscriber outlives file panes; theme updates never reload their documents. */
export function NativeChatVisualGuestThemePublisher(): null {
  const style = useNativeChatStoreAppearanceStyle()
  useEffect(() => {
    publishNativeChatVisualGuestTheme()
    const observer = new MutationObserver(publishNativeChatVisualGuestTheme)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style']
    })
    return () => observer.disconnect()
  }, [style])
  return null
}
