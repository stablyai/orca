import { describe, expect, it } from 'vitest'
import { buildTerminalKeyboardProtocolOptions } from '@/lib/pane-manager/terminal-keyboard-protocol'
import { buildDefaultTerminalOptions } from '@/lib/pane-manager/pane-terminal-options'
import { resolvePaneKeyboardProtocolAgent } from './terminal-keyboard-protocol-pane-agent'

const localWindowsConpty = {
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  osRelease: '10.0.26100',
  connectionId: null,
  cwd: 'C:\\repo',
  shellOverride: 'powershell.exe',
  executionHostId: 'local' as const
}

function resolvedKittyKeyboard(
  startup: { launchAgent?: 'grok' } | null | undefined,
  tabLaunchAgent: 'grok' | null = null
): boolean | undefined {
  const tuiAgent = resolvePaneKeyboardProtocolAgent(startup, tabLaunchAgent)
  const options = {
    ...buildDefaultTerminalOptions(),
    ...buildTerminalKeyboardProtocolOptions({ ...localWindowsConpty, tuiAgent })
  }
  return options.vtExtensions?.kittyKeyboard
}

describe('pane-scoped terminal keyboard protocol agent', () => {
  it('keeps KKP for the Grok startup pane but withholds it from a later shell split', () => {
    expect(resolvedKittyKeyboard({ launchAgent: 'grok' })).toBe(true)

    // The lifecycle consumes its one-shot startup before a user-created split.
    expect(resolvedKittyKeyboard(null)).toBe(false)
  })

  it('uses persisted Grok identity for a restored root but not its later sibling', () => {
    expect(resolvedKittyKeyboard(undefined, 'grok')).toBe(true)

    // onPaneCreated changes the lifecycle startup sentinel from undefined to null.
    expect(resolvedKittyKeyboard(null, 'grok')).toBe(false)
  })

  it('keeps explicit pane startup identity ahead of a stale tab launch agent', () => {
    expect(resolvePaneKeyboardProtocolAgent({ launchAgent: 'claude' }, 'grok')).toBe('claude')
  })
})
