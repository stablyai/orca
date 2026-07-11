import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WORKSPACE_TAB,
  normalizeDefaultWorkspaceTab,
  parseDefaultWorkspaceTab,
  serializeDefaultWorkspaceTab
} from './default-workspace-tab'

describe('normalizeDefaultWorkspaceTab', () => {
  it('coerces missing or unrecognized values to a terminal', () => {
    expect(normalizeDefaultWorkspaceTab(undefined)).toEqual({ kind: 'terminal' })
    expect(normalizeDefaultWorkspaceTab(null)).toEqual({ kind: 'terminal' })
    expect(normalizeDefaultWorkspaceTab('terminal')).toEqual({ kind: 'terminal' })
    expect(normalizeDefaultWorkspaceTab({})).toEqual({ kind: 'terminal' })
    expect(normalizeDefaultWorkspaceTab({ kind: 'nonsense' })).toEqual({ kind: 'terminal' })
  })

  it('keeps valid terminal and browser descriptors', () => {
    expect(normalizeDefaultWorkspaceTab({ kind: 'terminal' })).toEqual({ kind: 'terminal' })
    expect(normalizeDefaultWorkspaceTab({ kind: 'browser' })).toEqual({ kind: 'browser' })
  })

  it('validates the shell of a terminal-shell descriptor', () => {
    expect(
      normalizeDefaultWorkspaceTab({ kind: 'terminal-shell', shell: 'powershell.exe' })
    ).toEqual({ kind: 'terminal-shell', shell: 'powershell.exe' })
    expect(normalizeDefaultWorkspaceTab({ kind: 'terminal-shell', shell: 'git-bash' })).toEqual({
      kind: 'terminal-shell',
      shell: 'git-bash'
    })
    // An unrecognized (or dropped) shell degrades to a plain terminal.
    expect(normalizeDefaultWorkspaceTab({ kind: 'terminal-shell', shell: 'bash' })).toEqual({
      kind: 'terminal'
    })
    expect(normalizeDefaultWorkspaceTab({ kind: 'terminal-shell' })).toEqual({ kind: 'terminal' })
  })

  it('validates the agent of an agent descriptor', () => {
    expect(normalizeDefaultWorkspaceTab({ kind: 'agent', agent: 'claude' })).toEqual({
      kind: 'agent',
      agent: 'claude'
    })
    // An agent id removed in a later version degrades to a plain terminal.
    expect(normalizeDefaultWorkspaceTab({ kind: 'agent', agent: 'not-a-real-agent' })).toEqual({
      kind: 'terminal'
    })
    expect(normalizeDefaultWorkspaceTab({ kind: 'agent' })).toEqual({ kind: 'terminal' })
  })
})

describe('serializeDefaultWorkspaceTab and parseDefaultWorkspaceTab', () => {
  it('round-trips every descriptor kind', () => {
    const descriptors = [
      { kind: 'terminal' },
      { kind: 'browser' },
      { kind: 'terminal-shell', shell: 'cmd.exe' },
      { kind: 'agent', agent: 'claude' }
    ] as const
    for (const descriptor of descriptors) {
      expect(parseDefaultWorkspaceTab(serializeDefaultWorkspaceTab(descriptor))).toEqual(descriptor)
    }
  })

  it('serializes to stable string ids', () => {
    expect(serializeDefaultWorkspaceTab({ kind: 'terminal' })).toBe('terminal')
    expect(serializeDefaultWorkspaceTab({ kind: 'browser' })).toBe('browser')
    expect(serializeDefaultWorkspaceTab({ kind: 'terminal-shell', shell: 'wsl.exe' })).toBe(
      'terminal-shell:wsl.exe'
    )
    expect(serializeDefaultWorkspaceTab({ kind: 'agent', agent: 'codex' })).toBe('agent:codex')
  })

  it('parses invalid serialized values back to a terminal', () => {
    expect(parseDefaultWorkspaceTab('agent:not-real')).toEqual({ kind: 'terminal' })
    expect(parseDefaultWorkspaceTab('terminal-shell:nope')).toEqual({ kind: 'terminal' })
    expect(parseDefaultWorkspaceTab('garbage')).toEqual({ kind: 'terminal' })
  })

  it('defaults to a plain terminal', () => {
    expect(DEFAULT_WORKSPACE_TAB).toEqual({ kind: 'terminal' })
  })
})
