import { describe, expect, it } from 'vitest'
import { parseOrcaBrowserCommand } from './orca-browser-cli-commands'

describe('parseOrcaBrowserCommand', () => {
  it.each([
    ['orca click --element e3', null],
    ['orca snapshot --page p1', 'p1'],
    ['orca-dev fill --element e2 --text hi --page=p2', 'p2'],
    ["orca goto --url https://example.com --page='p3'", 'p3'],
    ['/Users/me/.local/bin/orca screenshot', null],
    ['C:\\Users\\me\\orca\\orca.cmd tab create', null],
    ['orca-ide mouse move --x 1 --y 2', null],
    ['cd app && orca click --element e3 --page p4', 'p4'],
    ['git status; ORCA_DEBUG=1 orca tab list', null],
    ['orca snapshot | head -20', null],
    ['orca browser identity get', null]
  ])('matches %s', (command, pageId) => {
    expect(parseOrcaBrowserCommand(command)).toEqual({ pageId })
  })

  it.each([
    'orca worktree ls',
    'orca terminal send --text "orca click"',
    'orcastra click',
    'orca',
    'echo orca click',
    'echo "docs; orca snapshot --page p1; text"',
    "git commit -m 'run orca click | orca snapshot'",
    'git log --oneline'
  ])('does not match %s', (command) => {
    expect(parseOrcaBrowserCommand(command)).toBeNull()
  })
})
