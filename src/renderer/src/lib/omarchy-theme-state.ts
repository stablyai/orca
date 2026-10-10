import type { OmarchyThemePalette } from '../../../shared/omarchy-theme-palette'

const STYLE_ELEMENT_ID = 'orca-omarchy-theme'
const ROOT_CLASS = 'omarchy-theme'

let currentPalette: OmarchyThemePalette | null = null
const listeners = new Set<() => void>()

export function getOmarchyThemePalette(): OmarchyThemePalette | null {
  return currentPalette
}

export function subscribeOmarchyThemePalette(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Null restores the stock theme. */
export function setOmarchyThemePalette(
  palette: OmarchyThemePalette | null,
  root: HTMLElement = document.documentElement
): void {
  currentPalette = palette
  applyOmarchyCssVars(palette, root)
  for (const listener of listeners) {
    listener()
  }
}

function applyOmarchyCssVars(palette: OmarchyThemePalette | null, root: HTMLElement): void {
  const doc = root.ownerDocument
  const existing = doc.getElementById(STYLE_ELEMENT_ID)
  if (!palette) {
    existing?.remove()
    root.classList.remove(ROOT_CLASS)
    return
  }
  const declarations = Object.entries(palette.cssVars)
    .map(([name, value]) => `${name}:${value};`)
    .join('')
  const style = existing ?? doc.createElement('style')
  style.id = STYLE_ELEMENT_ID
  // Why: `:root.omarchy-theme` outranks both the stock `:root` and `.dark` blocks in one write.
  style.textContent = `:root.${ROOT_CLASS}{${declarations}}`
  if (!existing) {
    doc.head.appendChild(style)
  }
  root.classList.add(ROOT_CLASS)
}
