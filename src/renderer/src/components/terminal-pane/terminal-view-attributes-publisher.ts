/**
 * Thin re-export + legacy global-only publish wrapper.
 * Full `{global, byAgent}` snapshots live in terminal-view-attributes-snapshot.ts.
 */
import type { ITheme } from '@xterm/xterm'
import type { GlobalSettings } from '../../../../shared/types'
import type { TerminalColorSchemeMode } from '../../../../shared/terminal-color-scheme-protocol'
import type { TerminalViewAttributes } from '../../../../shared/terminal-view-attributes'
import { composeTerminalViewAttributes } from '../../../../shared/terminal-view-attributes-composition'
import {
  _resetTerminalViewAttributesSnapshotForTest,
  publishComposedTerminalViewAttributesSnapshot
} from './terminal-view-attributes-snapshot'

export { composeTerminalViewAttributes } from '../../../../shared/terminal-view-attributes-composition'
export {
  buildTerminalViewAttributesSnapshot,
  publishTerminalViewAttributesSnapshot
} from './terminal-view-attributes-snapshot'

function sendLegacyAttributesViaPreload(attributes: TerminalViewAttributes): boolean {
  if (typeof window === 'undefined' || !window.api?.pty?.publishTerminalViewAttributes) {
    return false
  }
  window.api.pty.publishTerminalViewAttributes({
    kind: 'snapshot',
    global: attributes,
    byAgent: {}
  })
  return true
}

/** Publishes a snapshot with empty byAgent so existing callers keep compiling. */
export function publishTerminalViewAttributes(
  theme: ITheme | null,
  mode: TerminalColorSchemeMode,
  settings: Pick<GlobalSettings, 'terminalCursorStyle' | 'terminalCursorBlink'>,
  send: (attributes: TerminalViewAttributes) => boolean = sendLegacyAttributesViaPreload
): boolean {
  const attributes = composeTerminalViewAttributes(theme, mode, settings)
  return publishComposedTerminalViewAttributesSnapshot(
    { kind: 'snapshot', global: attributes, byAgent: {} },
    (push) => send(push.global)
  )
}

export function _resetTerminalViewAttributesPublisherForTest(): void {
  _resetTerminalViewAttributesSnapshotForTest()
}
