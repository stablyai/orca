import { useEffect } from 'react'
import { create } from 'zustand'
import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'
import {
  isPluginFontFamilyLabel,
  isPluginFontFamilyName,
  isPluginFontWeight,
  parsePluginFontSlot,
  pluginFontFamilyName
} from '../../../../../shared/plugins/contributions/plugin-font-contribution'
import { parsePluginImageUrl } from '../../../../../shared/plugins/images/plugin-image-url'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { isLivePlugin, usePluginListDerived } from '../catalog/plugin-contribution-catalog'

type PluginFontFace = { url: string; weight: string; style: 'normal' | 'italic' }

/** A font family from an enabled plugin, under the name Orca registers it as. */
export type ActivePluginFont = { family: string; faces: PluginFontFace[] }

/** Only URLs main serves for this plugin's own font slots, with the manifest's own rules. */
function isServedFace(face: PluginFontFace, pluginKey: string): boolean {
  const reference = parsePluginImageUrl(face.url)
  return (
    reference?.kind === 'installed' &&
    reference.pluginKey === pluginKey &&
    parsePluginFontSlot(reference.slot) !== null &&
    isPluginFontWeight(face.weight) &&
    (face.style === 'normal' || face.style === 'italic')
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
      const faces = font.faces.filter((face) => isServedFace(face, plugin.pluginKey))
      return isPluginFontFamilyLabel(font.family) && faces.length > 0
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

// Why a store: xterm and the code editor measure glyphs once per font change, so both re-measure
// when a plugin family finishes loading. Keys are lowercase, as CSS matches families.
export const usePluginFontLoadStore = create<{ loaded: ReadonlySet<string> }>()(() => ({
  loaded: new Set()
}))

const familyKey = (fontFamily: string): string => fontFamily.trim().toLowerCase()
const registered = new Map<string, { family: string; face: FontFace }>()
const familyByFace = new WeakMap<FontFace, string>()
const wantedFamilies = new Set<string>()
let watchingLoads = false

function setFamilyLoaded(family: string, loaded: boolean): void {
  const current = usePluginFontLoadStore.getState().loaded
  if (current.has(family) === loaded) {
    return
  }
  const next = new Set(current)
  if (loaded) {
    next.add(family)
  } else {
    next.delete(family)
  }
  usePluginFontLoadStore.setState({ loaded: next })
}

// Why the document event: a face also loads when the editor or interface first draws with it.
function watchFontLoads(): void {
  if (watchingLoads) {
    return
  }
  watchingLoads = true
  document.fonts.addEventListener('loadingdone', (event) => {
    for (const face of event.fontfaces) {
      const family = familyByFace.get(face)
      if (family && facesOf(family).includes(face)) {
        setFamilyLoaded(family, true)
      }
    }
  })
}

function facesOf(family: string): FontFace[] {
  return [...registered.values()].filter((entry) => entry.family === family).map((e) => e.face)
}

function loadFamily(family: string): void {
  const faces = facesOf(family)
  void Promise.allSettled(faces.map((face) => face.load())).then((results) => {
    if (results.some((result) => result.status === 'fulfilled')) {
      if (facesOf(family).some((face) => faces.includes(face))) {
        setFamilyLoaded(family, true)
      }
    } else if (faces.length > 0) {
      // The renderer's font sanitizer refused the files; the setting keeps its fallback.
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
  const next = new Map<string, { family: string; name: string; face: PluginFontFace }>()
  for (const font of fonts) {
    for (const face of font.faces) {
      const key = [font.family, face.url, face.weight, face.style].join('\u0000')
      next.set(key, { family: familyKey(font.family), name: font.family, face })
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
  for (const [key, { family, name, face }] of next) {
    if (registered.has(key)) {
      continue
    }
    watchFontLoads()
    // Why a quoted URL: it is a CSS string, so no URL can break out of it. The family is taken
    // literally, never parsed as CSS.
    const fontFace = new FontFace(name, `url(${JSON.stringify(face.url)})`, {
      weight: face.weight,
      style: face.style,
      display: 'swap'
    })
    document.fonts.add(fontFace)
    registered.set(key, { family, face: fontFace })
    familyByFace.set(fontFace, family)
    changedFamilies.add(family)
  }
  for (const family of changedFamilies) {
    const loaded = facesOf(family).some((face) => face.status === 'loaded')
    setFamilyLoaded(family, loaded)
    if (!loaded && wantedFamilies.has(family)) {
      loadFamily(family)
    }
  }
}

/** `fontFamily` once it is safe to measure: a plugin family that has not loaded yet is left out
 *  (and starts loading), so a terminal never sizes its cells with a fallback's metrics. */
export function pluginFontFamilyWhenLoaded(fontFamily: string): string {
  if (!isPluginFontFamilyName(fontFamily)) {
    return fontFamily
  }
  const family = familyKey(fontFamily)
  if (usePluginFontLoadStore.getState().loaded.has(family)) {
    return fontFamily
  }
  if (!wantedFamilies.has(family)) {
    wantedFamilies.add(family)
    loadFamily(family)
  }
  return ''
}

/** Changes when `fontFamily`, if it is a plugin family, loads or goes away; constant otherwise. */
export function usePluginFontReady(fontFamily: string | undefined): boolean {
  return usePluginFontLoadStore(
    (state) =>
      !fontFamily || !isPluginFontFamilyName(fontFamily) || state.loaded.has(familyKey(fontFamily))
  )
}

/** Calls `listener` whenever a plugin family loads or goes away. */
export function onPluginFontLoadsChanged(listener: () => void): () => void {
  return usePluginFontLoadStore.subscribe((state, previous) => {
    if (state.loaded !== previous.loaded) {
      listener()
    }
  })
}

/** Keeps the document's plugin font faces in step with the enabled plugins. */
export function usePluginFontRegistration(): void {
  const fonts = usePluginListDerived(collectActivePluginFonts)
  useEffect(() => syncPluginFontFaces(fonts), [fonts])
}
