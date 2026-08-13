/**
 * Builds and publishes the atomic `{global, byAgent}` view-attribute snapshot.
 * Does not import the publisher (one-way: publisher may import this file).
 */
import type { GlobalSettings, TuiAgent } from '../../../../shared/types'
import { composeActiveTerminalTheme } from '../../../../shared/compose-active-terminal-theme'
import { normalizeAgentTerminalThemes } from '../../../../shared/agent-terminal-themes'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { composeTerminalViewAttributes } from '../../../../shared/terminal-view-attributes-composition'
import type { TerminalViewAttributesPush } from '../../../../shared/terminal-view-attributes'
import { resolveEffectiveTerminalAppearance } from '../../lib/terminal-theme'

let lastPublishedSnapshot: string | null = null

type SnapshotSettings = Pick<
  GlobalSettings,
  | 'theme'
  | 'terminalThemeDark'
  | 'terminalDividerColorDark'
  | 'terminalUseSeparateLightTheme'
  | 'terminalThemeLight'
  | 'terminalCustomThemes'
  | 'terminalDividerColorLight'
  | 'agentTerminalThemes'
  | 'terminalColorOverrides'
  | 'terminalBackgroundOpacity'
  | 'terminalCursorOpacity'
  | 'terminalCursorStyle'
  | 'terminalCursorBlink'
>

function composeForAgent(
  settings: SnapshotSettings,
  systemPrefersDark: boolean,
  agent?: TuiAgent | null
) {
  const appearance = resolveEffectiveTerminalAppearance(settings, systemPrefersDark, agent)
  const theme = composeActiveTerminalTheme(appearance.theme, settings)
  return composeTerminalViewAttributes(theme, appearance.mode, settings)
}

export function buildTerminalViewAttributesSnapshot(
  settings: SnapshotSettings,
  systemPrefersDark: boolean
): TerminalViewAttributesPush {
  const global = composeForAgent(settings, systemPrefersDark)
  const byAgent: TerminalViewAttributesPush['byAgent'] = {}
  for (const agent of Object.keys(normalizeAgentTerminalThemes(settings.agentTerminalThemes))) {
    if (!isTuiAgent(agent)) {
      continue
    }
    byAgent[agent] = composeForAgent(settings, systemPrefersDark, agent)
  }
  return { kind: 'snapshot', global, byAgent }
}

function sendSnapshotViaPreload(push: TerminalViewAttributesPush): boolean {
  if (typeof window === 'undefined' || !window.api?.pty?.publishTerminalViewAttributes) {
    return false
  }
  window.api.pty.publishTerminalViewAttributes(push)
  return true
}

export function publishComposedTerminalViewAttributesSnapshot(
  push: TerminalViewAttributesPush,
  send: (push: TerminalViewAttributesPush) => boolean
): boolean {
  const serialized = JSON.stringify(push)
  if (serialized === lastPublishedSnapshot) {
    return false
  }
  if (!send(push)) {
    return false
  }
  lastPublishedSnapshot = serialized
  return true
}

export function publishTerminalViewAttributesSnapshot(
  settings: SnapshotSettings,
  systemPrefersDark: boolean,
  send: (push: TerminalViewAttributesPush) => boolean = sendSnapshotViaPreload
): boolean {
  return publishComposedTerminalViewAttributesSnapshot(
    buildTerminalViewAttributesSnapshot(settings, systemPrefersDark),
    send
  )
}

export function _resetTerminalViewAttributesSnapshotForTest(): void {
  lastPublishedSnapshot = null
}
