import { describe, expect, it } from 'vitest'
import type { AgentPickerDraft } from '../../../../shared/agent-launch-picker'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  createComposerAgentEntry,
  entriesToLaunchList,
  isLegacySingleAgentSubmit,
  resolveComposerAgentLaunchList,
  type ComposerAgentEntry
} from './composer-agent-entries'

function entryOf(
  agent: TuiAgent,
  draft: Partial<AgentPickerDraft> = {},
  displayName = ''
): ComposerAgentEntry {
  const created = createComposerAgentEntry(agent)
  return { ...created, draft: { ...created.draft, ...draft }, displayName }
}

describe('createComposerAgentEntry', () => {
  it('starts a bare terminal draft for the picked agent', () => {
    const entry = createComposerAgentEntry('codex')
    expect(entry.draft).toEqual({
      agent: 'codex',
      surface: 'terminal',
      choices: {},
      arguments: undefined
    })
    expect(entry.displayName).toBe('')
    expect(entry.id).not.toBe('')
  })

  it('keeps same-harness rows distinct', () => {
    expect(createComposerAgentEntry('claude').id).not.toBe(createComposerAgentEntry('claude').id)
  })
})

describe('entriesToLaunchList', () => {
  it('maps one bare row to a surface-only launch entry', () => {
    expect(entriesToLaunchList([entryOf('codex')])).toEqual([
      { agent: 'codex', requestedSurface: 'terminal' }
    ])
  })

  it('keeps same-harness rows distinct with trimmed names and their own surfaces', () => {
    const launches = entriesToLaunchList([
      entryOf('codex', { arguments: '--profile fast' }, '  Worker  '),
      entryOf('codex', { surface: 'chat', choices: { model: 'gpt-5' } }, 'reviewer')
    ])

    expect(launches).toEqual([
      {
        agent: 'codex',
        agentArgs: '--profile fast',
        requestedSurface: 'terminal',
        displayName: 'Worker'
      },
      {
        agent: 'codex',
        sessionOptions: { model: 'gpt-5' },
        requestedSurface: 'chat',
        displayName: 'reviewer'
      }
    ])
  })

  it('emits both rows when same-harness entries share an empty name', () => {
    const launches = entriesToLaunchList([
      entryOf('claude'),
      entryOf('claude', { arguments: '--verbose' })
    ])

    expect(launches).toHaveLength(2)
    expect(launches[0]).not.toHaveProperty('displayName')
    expect(launches[1]).not.toHaveProperty('displayName')
  })

  it('survives a JSON round-trip', () => {
    const launches = entriesToLaunchList([
      entryOf('codex', { arguments: '--profile fast' }, 'worker'),
      entryOf('codex', { surface: 'chat', choices: { model: 'gpt-5' } })
    ])

    expect(JSON.parse(JSON.stringify(launches))).toEqual(launches)
  })
})

describe('isLegacySingleAgentSubmit', () => {
  it('stays legacy for one bare row and for no rows', () => {
    expect(isLegacySingleAgentSubmit([entryOf('codex')])).toBe(true)
    expect(isLegacySingleAgentSubmit([])).toBe(true)
  })

  it('leaves the legacy path for a second row', () => {
    expect(isLegacySingleAgentSubmit([entryOf('codex'), entryOf('claude')])).toBe(false)
  })

  it('leaves the legacy path for one row with arguments', () => {
    expect(isLegacySingleAgentSubmit([entryOf('codex', { arguments: '--profile fast' })])).toBe(
      false
    )
  })

  it('leaves the legacy path for one row with a custom name', () => {
    expect(isLegacySingleAgentSubmit([entryOf('codex', {}, 'worker')])).toBe(false)
  })

  it('leaves the legacy path for one row with session options', () => {
    expect(
      isLegacySingleAgentSubmit([entryOf('codex', { choices: { permissionMode: 'ask' } })])
    ).toBe(false)
  })

  it('keeps a surface-only row on the legacy path', () => {
    expect(isLegacySingleAgentSubmit([entryOf('codex', { surface: 'chat' })])).toBe(true)
  })

  it('ignores a whitespace-only name and cleared arguments', () => {
    expect(isLegacySingleAgentSubmit([entryOf('codex', { arguments: null }, '   ')])).toBe(true)
  })
})

describe('resolveComposerAgentLaunchList', () => {
  it('keeps the legacy path for a single bare row and for no selection', () => {
    expect(
      resolveComposerAgentLaunchList({
        selection: { entries: [entryOf('codex')], locked: false },
        gitWorktree: true,
        remote: false
      })
    ).toBeNull()
    expect(
      resolveComposerAgentLaunchList({ selection: undefined, gitWorktree: true, remote: false })
    ).toBeNull()
  })

  it('maps rows verbatim when a second row exists', () => {
    const entries = [
      entryOf('codex', { arguments: '--profile fast' }, 'worker'),
      entryOf('claude', { surface: 'chat' })
    ]
    expect(
      resolveComposerAgentLaunchList({
        selection: { entries, locked: false },
        gitWorktree: true,
        remote: false
      })
    ).toEqual(entriesToLaunchList(entries))
  })

  it.each([
    ['folder/VM locked', { locked: true, gitWorktree: true, remote: false }],
    ['non-git workspace', { locked: false, gitWorktree: false, remote: false }],
    ['remote host', { locked: false, gitWorktree: true, remote: true }]
  ])('collapses to the legacy path for %s', (_label, flags) => {
    expect(
      resolveComposerAgentLaunchList({
        selection: { entries: [entryOf('codex'), entryOf('claude')], locked: flags.locked },
        gitWorktree: flags.gitWorktree,
        remote: flags.remote
      })
    ).toBeNull()
  })
})
