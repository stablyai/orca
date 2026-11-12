import { BUNDLED_SYMBOLS_FONT_FAMILY } from '../../../../../shared/monospace-font-family'
import { resetAndRefreshAllTerminalWebglAtlases } from '../pane-manager-registry'

let watching = false

function isSymbolsFace(face: FontFace): boolean {
  return face.family.replace(/["']/g, '') === BUNDLED_SYMBOLS_FONT_FAMILY
}

/** WebGL atlases cache PUA glyphs drawn before Chromium lazily loads the bundled face, so repaint once it lands. */
export function watchTerminalSymbolsFontLoad(): void {
  if (watching || typeof document === 'undefined' || !document.fonts) {
    return
  }
  watching = true
  const fonts = document.fonts
  const onLoadingDone = (event: FontFaceSetLoadEvent): void => {
    if (!event.fontfaces.some(isSymbolsFace)) {
      return
    }
    fonts.removeEventListener('loadingdone', onLoadingDone)
    resetAndRefreshAllTerminalWebglAtlases('symbols-font-loaded', { includeHidden: true })
  }
  fonts.addEventListener('loadingdone', onLoadingDone)
}
