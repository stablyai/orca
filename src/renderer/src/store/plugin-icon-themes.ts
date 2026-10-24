import { useEffect } from 'react'
import { create } from 'zustand'
import {
  isPluginIconThemeMetadata,
  isPluginIconThemeRegistration,
  type PluginIconThemeMetadata,
  type PluginIconThemeRegistration
} from '../../../shared/plugins/plugin-icon-theme-artifact'
import { sanitizePluginIconSvg } from '../lib/plugin-icon-svg'
import { createPluginContentListStore } from './plugin-content-list-store'

const iconThemes = createPluginContentListStore<PluginIconThemeMetadata>({
  kind: 'icon themes',
  list: (api) => api.listIconThemes,
  isEntry: isPluginIconThemeMetadata
})

export const usePluginIconThemes = iconThemes.useEntries

/** The selected icon theme as indexes into its registered icons; null means built-in icons. */
export type ActivePluginIconTheme = Pick<
  PluginIconThemeRegistration,
  'icons' | 'fileNames' | 'fileExtensions'
>

export const useActivePluginIconTheme = create<{ theme: ActivePluginIconTheme | null }>()(() => ({
  theme: null
}))

/** Attribute that selects an icon's one shared CSS rule; rows carry only the index. */
export const PLUGIN_ICON_ATTRIBUTE = 'data-plugin-icon'
const STYLE_ELEMENT_ID = 'orca-plugin-icon-theme'
let registeredUrls: string[] = []
let loadGeneration = 0

function clearRegisteredIcons(): void {
  document.getElementById(STYLE_ELEMENT_ID)?.remove()
  for (const url of registeredUrls) {
    URL.revokeObjectURL(url)
  }
  registeredUrls = []
}

// Why one stylesheet: each SVG becomes one blob URL and one rule, so a long file tree does
// not repeat image data per row. Unusable SVGs get no rule and fall back to built-in icons.
function registerIcons(theme: PluginIconThemeRegistration): ActivePluginIconTheme {
  clearRegisteredIcons()
  const usable = new Set<number>()
  const rules = theme.svgs.flatMap((source, index) => {
    const icon = sanitizePluginIconSvg(source)
    if (!icon) {
      return []
    }
    const url = URL.createObjectURL(new Blob([icon.svg], { type: 'image/svg+xml' }))
    registeredUrls.push(url)
    usable.add(index)
    const image = `url("${url}") center / contain no-repeat`
    return [
      icon.monochrome
        ? `[${PLUGIN_ICON_ATTRIBUTE}="${index}"]{display:inline-block;background-color:currentColor;-webkit-mask:${image};mask:${image}}`
        : `[${PLUGIN_ICON_ATTRIBUTE}="${index}"]{display:inline-block;background:${image}}`
    ]
  })
  const style = document.createElement('style')
  style.id = STYLE_ELEMENT_ID
  style.textContent = rules.join('\n')
  document.head.append(style)
  const keep = (entries: Record<string, number>) =>
    Object.fromEntries(Object.entries(entries).filter(([, index]) => usable.has(index)))
  return {
    icons: keep(theme.icons),
    fileNames: keep(theme.fileNames),
    fileExtensions: keep(theme.fileExtensions)
  }
}

/** Loads the selected icon theme whenever the selection or the enabled themes change. */
export function usePluginIconThemeActivation(selectedId: string | null | undefined): void {
  const available = usePluginIconThemes()
  const selected = available.find((theme) => theme.id === selectedId)?.id ?? null
  useEffect(() => {
    const generation = ++loadGeneration
    const load = window.api?.plugins?.loadIconTheme
    if (!selected || !load) {
      clearRegisteredIcons()
      useActivePluginIconTheme.setState({ theme: null })
      return
    }
    void load(selected)
      .then((theme) => (isPluginIconThemeRegistration(theme) ? theme : null))
      .catch(() => null)
      .then((theme) => {
        if (generation === loadGeneration) {
          useActivePluginIconTheme.setState({ theme: theme ? registerIcons(theme) : null })
        }
      })
  }, [selected, available])
}
