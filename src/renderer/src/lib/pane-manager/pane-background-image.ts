import type { PaneStyleOptions } from './pane-manager-types'
import {
  DEFAULT_TERMINAL_BACKGROUND_IMAGE_OPACITY,
  resolveTerminalBackgroundImageCss
} from '../../../../shared/terminal-background-image'

export const PANE_BACKGROUND_IMAGE_CLASS = 'pane-background-image-host'

// Why a ::before on the root instead of a DOM node: layout sweeps treat root.firstElementChild as the
// split tree, and dispose wipes root.innerHTML, so an inserted element would be fragile either way.
export function applyRootBackgroundImage(root: HTMLElement, styleOptions: PaneStyleOptions): void {
  const image = styleOptions.backgroundImage
  if (!image) {
    root.classList.remove(PANE_BACKGROUND_IMAGE_CLASS)
    root.style.removeProperty('--pane-background-image')
    root.style.removeProperty('--pane-background-image-opacity')
    root.style.removeProperty('--pane-background-image-size')
    root.style.removeProperty('--pane-background-image-position')
    root.style.removeProperty('--pane-background-image-repeat')
    return
  }
  const css = resolveTerminalBackgroundImageCss(styleOptions.backgroundImageFit)
  root.classList.add(PANE_BACKGROUND_IMAGE_CLASS)
  root.style.setProperty('--pane-background-image', `url("${image}")`)
  root.style.setProperty(
    '--pane-background-image-opacity',
    String(styleOptions.backgroundImageOpacity ?? DEFAULT_TERMINAL_BACKGROUND_IMAGE_OPACITY)
  )
  root.style.setProperty('--pane-background-image-size', css.size)
  root.style.setProperty('--pane-background-image-position', css.position)
  root.style.setProperty('--pane-background-image-repeat', css.repeat)
}
