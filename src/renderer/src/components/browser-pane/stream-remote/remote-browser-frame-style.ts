import type { CSSProperties } from 'react'
import type { BrowserScreencastFrameMetadata } from '../../../../../shared/browser/screencast/browser-screencast-protocol'
import { getPositiveFiniteNumber } from './remote-browser-page-input-model'

// Use the host’s displayed CSS viewport; bitmap dimensions vary with DPR and frame-budget scaling.
export function getRemoteBrowserFrameStyle(
  metadata: BrowserScreencastFrameMetadata | null
): CSSProperties {
  const width = getPositiveFiniteNumber(metadata?.deviceWidth)
  const height = getPositiveFiniteNumber(metadata?.deviceHeight)
  if (!width || !height) {
    return { width: '100%', height: '100%', objectFit: 'fill', objectPosition: 'top left' }
  }
  // Contain smaller or pre-resize frames without distortion; pointer mapping uses this same letterboxed box.
  const aspect = width / height
  return {
    inset: 0,
    margin: 'auto',
    width: `min(100cqw, calc(100cqh * ${aspect}))`,
    height: `min(100cqh, calc(100cqw / ${aspect}))`,
    objectFit: 'fill'
  }
}

// Electron's cursor-changed types that CSS names the same; the rest are mapped below.
const SHARED_CURSOR_NAMES = new Set([
  'crosshair',
  'text',
  'wait',
  'help',
  'e-resize',
  'n-resize',
  'ne-resize',
  'nw-resize',
  's-resize',
  'se-resize',
  'sw-resize',
  'w-resize',
  'ns-resize',
  'ew-resize',
  'nesw-resize',
  'nwse-resize',
  'col-resize',
  'row-resize',
  'move',
  'vertical-text',
  'cell',
  'context-menu',
  'alias',
  'progress',
  'copy',
  'none',
  'not-allowed',
  'zoom-in',
  'zoom-out',
  'grab',
  'grabbing'
])

const RENAMED_CURSORS: Record<string, CSSProperties['cursor']> = {
  // Electron calls the arrow `pointer` and the link hand `hand`.
  hand: 'pointer',
  nodrop: 'no-drop',
  'drag-drop-none': 'no-drop',
  'drag-drop-move': 'move',
  'drag-drop-copy': 'copy',
  'drag-drop-link': 'alias'
}

/** The CSS cursor for the host guest's Electron cursor type; a custom image falls back to the arrow. */
export function getRemoteBrowserFrameCursor(type: string | undefined): CSSProperties['cursor'] {
  if (!type) {
    return 'default'
  }
  if (type.includes('-panning')) {
    return 'all-scroll'
  }
  return RENAMED_CURSORS[type] ?? (SHARED_CURSOR_NAMES.has(type) ? type : 'default')
}
