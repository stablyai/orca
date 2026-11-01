import type { EditorTypographySettings } from '../../../shared/editor-typography-settings-types'
import { isMacUserAgent } from '@/components/terminal-pane/pane-helpers'

export type CodeFontSmoothing = NonNullable<EditorTypographySettings['codeFontSmoothing']>

const CODE_FONT_SMOOTHING_ATTRIBUTE = 'data-code-font-smoothing'

/** Only macOS honors -webkit-font-smoothing, so other platforms hide the setting. */
export function supportsCodeFontSmoothing(): boolean {
  return isMacUserAgent()
}

/** Marks the root so main.css can opt code surfaces out of the app-wide grayscale; returns whether it changed. */
export function applyCodeFontSmoothing(mode: CodeFontSmoothing | null | undefined): boolean {
  const root = document.documentElement
  const native = mode === 'native' && supportsCodeFontSmoothing()
  if (root.hasAttribute(CODE_FONT_SMOOTHING_ATTRIBUTE) === native) {
    return false
  }
  root.toggleAttribute(CODE_FONT_SMOOTHING_ATTRIBUTE, native)
  return true
}
