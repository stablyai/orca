import { useSyncExternalStore } from 'react'

// The Settings page's active section, for chrome that sits outside the section content (the
// header's Host switcher). Written by the page effects; read with useSettingsActiveSection.
let activeSectionId: string | null = null
const listeners = new Set<() => void>()

export function setSettingsActiveSection(id: string | null): void {
  if (id === activeSectionId) {
    return
  }
  activeSectionId = id
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useSettingsActiveSection(): string | null {
  return useSyncExternalStore(subscribe, () => activeSectionId)
}
