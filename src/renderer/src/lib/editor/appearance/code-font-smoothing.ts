import type { EditorTypographySettings } from '../../../../../shared/editor-typography-settings-types'
import { isMacUserAgent } from '@/app-shell/platform/user-agent-platform'

export type CodeFontSmoothing = NonNullable<EditorTypographySettings['codeFontSmoothing']>

const CODE_FONT_SMOOTHING_ATTRIBUTE = 'data-code-font-smoothing'

/** Marks the root so main.css can opt code surfaces out of the app-wide grayscale; returns whether it changed. */
export function applyCodeFontSmoothing(mode: CodeFontSmoothing | null | undefined): boolean {
  const root = document.documentElement
  const native = mode === 'native' && isMacUserAgent()
  if (root.hasAttribute(CODE_FONT_SMOOTHING_ATTRIBUTE) === native) {
    return false
  }
  root.toggleAttribute(CODE_FONT_SMOOTHING_ATTRIBUTE, native)
  return true
}
