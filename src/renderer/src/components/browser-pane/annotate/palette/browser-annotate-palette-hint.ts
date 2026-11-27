import type { Translate } from '@/i18n/use-translate'
import {
  isBrowserAnnotationPageFull,
  type GrabIntent
} from '../../../../../../shared/browser/element-grab/browser-grab-types'
import { browserAnnotationLimitMessage } from '../delivery/browser-annotation-limit-message'
import type { GrabModeHook } from '../grab/useGrabMode'
import type { BrowserAnnotateTool } from './use-browser-annotate-tool-switch'

/**
 * The palette's one-line hint; empty once the palette's own controls say it (Draw, notes, a Grab pick).
 * `keepWhenCompact` marks a status or key instruction the user must see even where a compacted palette drops its tips.
 */
export function browserAnnotatePaletteHint({
  t,
  activeTool,
  grab,
  grabIntent,
  hasPendingAnnotation,
  browserAnnotationsLength,
  drawWaitingForPage = false
}: {
  t: Translate
  activeTool: BrowserAnnotateTool
  grab: Pick<GrabModeHook, 'state' | 'error'>
  grabIntent: GrabIntent
  hasPendingAnnotation: boolean
  browserAnnotationsLength: number
  /** Draw was chosen while the page is still loading. */
  drawWaitingForPage?: boolean
}): { text: string; isError: boolean; keepWhenCompact?: boolean } {
  if (activeTool === 'draw' && drawWaitingForPage) {
    return {
      text: t('browser.annotatePalette.waitingForPage', 'Waiting for page…'),
      isError: false,
      keepWhenCompact: true
    }
  }
  if (activeTool === 'draw') {
    return { text: '', isError: false }
  }
  if (grab.state === 'error') {
    return {
      text: t('auto.components.browser.pane.BrowserPane.4328a0a062', 'Grab failed: {{value0}}', {
        value0: grab.error ?? 'Unknown error'
      }),
      isError: true,
      keepWhenCompact: true
    }
  }
  if (grabIntent === 'annotate') {
    if (hasPendingAnnotation) {
      return {
        text: t(
          'auto.components.browser.pane.BrowserPane.b733a91bd9',
          'Add feedback for the selected element.'
        ),
        isError: false
      }
    }
    if (isBrowserAnnotationPageFull(browserAnnotationsLength)) {
      return { text: browserAnnotationLimitMessage(t), isError: false, keepWhenCompact: true }
    }
    // The palette's note count and Send say the rest; a second sentence here would point at actions not shown.
    if (browserAnnotationsLength > 0) {
      return { text: '', isError: false }
    }
    return {
      text: t(
        'auto.components.browser.pane.BrowserPane.777b5bc4ec',
        'Click an element to add feedback for the agent.'
      ),
      isError: false
    }
  }
  // After a pick the Copy button shows Copied and Screenshot sits beside it, so no hint repeats them.
  if (grab.state === 'confirming') {
    return { text: '', isError: false }
  }
  return {
    text: t(
      'auto.components.browser.pane.BrowserPane.168350ae6a',
      'Click or hover an element, then press C to copy or S to screenshot.'
    ),
    isError: false,
    // The only place the C/S keys are named, so a compacted palette keeps it.
    keepWhenCompact: true
  }
}
