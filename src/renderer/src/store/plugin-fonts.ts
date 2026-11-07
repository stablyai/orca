import { useEffect } from 'react'
import { create } from 'zustand'
import type { PluginHostListEntry } from '../../../preload/api-types'
import {
  parsePluginFontSlot,
  pluginFontFamilyName
} from '../../../shared/plugins/contributions/plugin-font-contribution'
import { parsePluginImageUrl } from '../../../shared/plugins/images/plugin-image-url'
import { isWebClientLocation } from '@/lib/web-client-location'
import { isLivePlugin, usePluginListDerived } from './plugin-panels'

type PluginFontFace = { url: string; weight: string; style: 'normal' | 'italic' }

/** A font family from an enabled plugin, under the name Orca registers it as. */
export type ActivePluginFont = { family: string; faces: PluginFontFace[] }

/** Only URLs main serves for this plugin's own font slots; anything else is dropped. */
function isOwnFontUrl(url: string, pluginKey: string): boolean {
  const reference = parsePluginImageUrl(url)
  return (
    reference?.kind === 'installed' &&
    reference.pluginKey === pluginKey &&
    parsePluginFontSlot(reference.slot) !== null
  )
}

export function collectActivePluginFonts(
  plugins: readonly PluginHostListEntry[]
): ActivePluginFont[] {
  // Why desktop only: a web client cannot load the scheme main serves fonts from.
  if (isWebClientLocation()) {
    return []
  }
  return plugins.filter(isLivePlugin).flatMap((plugin) =>
    (plugin.fonts ?? []).flatMap((font) => {
      const faces = font.faces.filter((face) => isOwnFontUrl(face.url, plugin.pluginKey))
      return faces.length > 0
        ? [{ family: pluginFontFamilyName(plugin.pluginKey, font.family), faces }]
        : []
    })
  )
}

const collectFamilies = (plugins: readonly PluginHostListEntry[]): string[] =>
  collectActivePluginFonts(plugins).map((font) => font.family)

/** Families of enabled plugins' fonts, for the font pickers. */
export function usePluginFontFamilies(): string[] {
  return usePluginListDerived(collectFamilies)
}

// Why a revision: xterm measures its cell once per font change, so a terminal may name a plugin
// family only after it loads; this store tells terminals to re-apply their font then.
export const usePluginFontLoadStore = create<{ revision: number }>()(() => ({ revision: 0 }))

const registered = new Map<string, { family: string; face: FontFace }>()
const loadedFamilies = new Set<string>()
const wantedFamilies = new Set<string>()
const PLUGIN_FONT_FAMILY_RE = / \([a-z0-9-]+\.[a-z0-9-]+\)$/

function faceKey(family: string, face: PluginFontFace): string {
  return [family, face.url, face.weight, face.style].join('\u0000')
}

function bumpRevision(): void {
  usePluginFontLoadStore.setState((state) => ({ revision: state.revision + 1 }))
}

function loadFamily(family: string): void {
  const faces = [...registered.values()].filter((entry) => entry.family === family)
  if (faces.length === 0) {
    return
  }
  void Promise.allSettled(faces.map((entry) => entry.face.load())).then((results) => {
    const stillRegistered = faces.some((entry) => [...registered.values()].includes(entry))
    if (!stillRegistered || loadedFamilies.has(family)) {
      return
    }
    if (results.some((result) => result.status === 'fulfilled')) {
      loadedFamilies.add(family)
      bumpRevision()
    } else {
      // The renderer's font sanitizer refuses malformed files; the setting then keeps its fallback.
      console.warn(`[plugins] font "${family}" failed to load`)
    }
  })
}

/** Registers enabled plugins' faces and removes those of disabled or uninstalled ones. Faces
 *  load only when text uses them, so registering costs nothing until a font is picked. */
export function syncPluginFontFaces(fonts: readonly ActivePluginFont[]): void {
  if (typeof document === 'undefined' || !document.fonts) {
    return
  }
  const next = new Map<string, { family: string; face: PluginFontFace }>()
  for (const font of fonts) {
    for (const face of font.faces) {
      next.set(faceKey(font.family, face), { family: font.family, face })
    }
  }
  const changedFamilies = new Set<string>()
  for (const [key, entry] of registered) {
    if (!next.has(key)) {
      document.fonts.delete(entry.face)
      registered.delete(key)
      changedFamilies.add(entry.family)
    }
  }
  for (const [key, { family, face }] of next) {
    if (registered.has(key)) {
      continue
    }
    // Why a quoted URL: it is a CSS string, so no URL can break out of it. The family is taken
    // literally, never parsed as CSS.
    const fontFace = new FontFace(family, `url(${JSON.stringify(face.url)})`, {
      weight: face.weight,
      style: face.style,
      display: 'swap'
    })
    document.fonts.add(fontFace)
    registered.set(key, { family, face: fontFace })
    changedFamilies.add(family)
  }
  let wantedChanged = false
  for (const family of changedFamilies) {
    if (loadedFamilies.delete(family) && wantedFamilies.has(family)) {
      wantedChanged = true
    }
    if (wantedFamilies.has(family)) {
      loadFamily(family)
    }
  }
  if (wantedChanged) {
    bumpRevision()
  }
}

/** `fontFamily` once it is safe to measure: a plugin family that has not loaded yet is left out
 *  (and starts loading), so a terminal never sizes its cells with a fallback's metrics. */
export function pluginFontFamilyWhenLoaded(fontFamily: string): string {
  const family = fontFamily.trim()
  if (!PLUGIN_FONT_FAMILY_RE.test(family) || loadedFamilies.has(family)) {
    return fontFamily
  }
  if (!wantedFamilies.has(family)) {
    wantedFamilies.add(family)
    loadFamily(family)
  }
  return ''
}

const collectFonts = (plugins: readonly PluginHostListEntry[]): ActivePluginFont[] =>
  collectActivePluginFonts(plugins)

/** Keeps the document's plugin font faces in step with the enabled plugins. */
export function usePluginFontRegistration(): void {
  const fonts = usePluginListDerived(collectFonts)
  useEffect(() => syncPluginFontFaces(fonts), [fonts])
}
