import { useSyncExternalStore } from 'react'
import { isWindowsDesktopClient } from '@/lib/windows-path-access'

// One font list backs every font picker, so its availability is shared too.
let installedFontsUnavailable = false
const listeners = new Set<() => void>()

export function setInstalledFontsUnavailable(unavailable: boolean): void {
  if (installedFontsUnavailable === unavailable) {
    return
  }
  installedFontsUnavailable = unavailable
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getInstalledFontsUnavailable(): boolean {
  return installedFontsUnavailable
}

export function useInstalledFontsUnavailable(): boolean {
  return useSyncExternalStore(subscribe, getInstalledFontsUnavailable)
}

// Chromium enumerates Windows fonts in-process; main's PowerShell fallback can be blocked by policy.
export async function listInstalledFontFamilies(): Promise<string[]> {
  if (isWindowsDesktopClient() && window.queryLocalFonts) {
    try {
      const fonts = await window.queryLocalFonts()
      const families = [...new Set(fonts.map((font) => font.family.trim()).filter(Boolean))]
      if (families.length > 0) {
        return families.sort((a, b) => a.localeCompare(b))
      }
    } catch (error) {
      console.warn('[fonts] queryLocalFonts failed; falling back to the OS font list:', error)
    }
  }
  return window.api.settings.listFonts()
}
