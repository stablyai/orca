import { describe, expect, it } from 'vitest'
import type { NativeChatBlock, NativeChatMessage } from '../native-chat/native-chat-types'
import { firstLookRows } from './bot-first-look'

const CLI = '"${ORCA_CLI_COMMAND:-orca}"'

function turn(blocks: NativeChatBlock[]): NativeChatMessage[] {
  return [
    {
      id: 'm1',
      role: 'assistant',
      blocks,
      timestamp: null,
      source: 'transcript'
    }
  ]
}

const bash = (callId: string, command: string): NativeChatBlock => ({
  type: 'tool-call',
  name: 'Bash',
  callId,
  input: { command }
})

const result = (callId: string, output: unknown, isError = false): NativeChatBlock => ({
  type: 'tool-result',
  callId,
  output: typeof output === 'string' ? output : JSON.stringify(output),
  isError
})

const lines = (count: number, line: (index: number) => string): string =>
  Array.from({ length: count }, (_, index) => line(index)).join('\n')

describe('a new bot’s first look', () => {
  it('lists each area it read, with what its JSON output counted', () => {
    const rows = firstLookRows(
      turn([
        bash('1', `${CLI} repo list --json`),
        result('1', {
          id: 'x',
          ok: true,
          result: {
            repos: [{ displayName: 'orca' }, { displayName: 'relay' }]
          }
        }),
        bash('2', 'gh search prs --author=@me --state=open --json url,title'),
        result('2', [{ url: 'a' }, { url: 'b' }, { url: 'c' }]),
        bash('3', `${CLI} linear list-issues --assignee me --json`),
        result('3', { result: { issues: [{ id: 1 }] } }),
        bash('4', 'claude mcp list'),
        result(
          '4',
          'sentry: npx sentry-mcp - ✓ Connected\nnotion: https://mcp.notion.com (HTTP) - ✓ Connected'
        )
      ]),
      true
    )
    expect(rows).toEqual([
      { area: 'projects', state: 'done', count: 2, names: ['orca', 'relay'] },
      { area: 'github', state: 'done', count: 3 },
      { area: 'linear', state: 'done', count: 1 },
      { area: 'tools', state: 'done', count: 2, names: ['sentry', 'notion'] }
    ])
  })

  it('gives a source it could not read no row, and marks a read cut off by the turn’s end', () => {
    const blocks = [
      bash('1', 'cd ~/work && gh pr list --json number'),
      result('1', 'gh auth login required', true),
      bash('2', `${CLI} linear list-issues --assignee me --json`),
      bash('3', 'git status')
    ]
    expect(firstLookRows(turn(blocks), false)).toEqual([{ area: 'linear', state: 'running' }])
    expect(firstLookRows(turn(blocks), true)).toEqual([{ area: 'linear', state: 'stopped' }])
  })

  it('keeps a count when a later read of the same area prints none', () => {
    const rows = firstLookRows(
      turn([
        bash('1', 'gh search prs --author=@me --json url'),
        result('1', [{ url: 'a' }]),
        bash('2', 'gh pr checks 12'),
        result('2', 'all checks passed')
      ]),
      true
    )
    expect(rows).toEqual([{ area: 'github', state: 'done', count: 1 }])
  })

  it('counts the plain lists the first-run commands print', () => {
    const rows = firstLookRows(
      turn([
        bash('1', `${CLI} repo list`),
        result('1', 'r1  orca  /src/orca\nr2  relay cell  /src/relay'),
        bash('2', "gh search prs --author=@me --state=open --limit 100 --jq '.[]'"),
        result('2', 'stablyai/orca#1 Fix it\nstablyai/orca#2 Ship it\n'),
        bash('3', `${CLI} linear list-issues --assignee me --state open --limit 50`),
        result('3', `${lines(50, (i) => `STA-${i}  Todo  me  Issue ${i}`)}\ntruncated: showing 50`),
        bash('4', 'codex mcp list --json'),
        result('4', [{ name: 'sentry' }])
      ]),
      true
    )
    expect(rows).toEqual([
      {
        area: 'projects',
        state: 'done',
        count: 2,
        names: ['orca', 'relay cell']
      },
      { area: 'github', state: 'done', count: 2 },
      { area: 'linear', state: 'done', count: 50, more: true },
      { area: 'tools', state: 'done', count: 1, names: ['sentry'] }
    ])
  })

  it('counts the workspaces with an agent open, from text or JSON', () => {
    const ps = [
      'webhooks · orca · host=local · active 25m ago',
      '--worktree id:r1::/src/webhooks',
      'agent claude idle, 25m ago (--terminal term_a)',
      '  last asked: the bot row should list a workspace',
      '',
      'mobile-ota · orca · host=local · active 3d ago',
      '--worktree id:r1::/src/mobile-ota',
      'no agent open',
      '',
      'Builder · Builder (folder) · host=local · home of bot Builder',
      '--worktree id:folder:b1  /bots/b1',
      'agent claude idle (--terminal chat:s1)',
      '',
      'Host scope: local'
    ].join('\n')
    const text = firstLookRows(
      turn([bash('1', `${CLI} worktree ps --since 7d`), result('1', ps)]),
      true
    )
    expect(text).toEqual([{ area: 'workspaces', state: 'done', count: 1 }])
    const json = firstLookRows(
      turn([
        bash('1', `${CLI} worktree ps --since 7d --json`),
        result('1', {
          result: {
            worktrees: [
              { agents: [{ address: 'term_a' }] },
              { agents: [{ state: 'done' }] },
              { agents: [] },
              { botHome: true, agents: [{ address: 'chat:s1' }] }
            ]
          }
        })
      ]),
      true
    )
    expect(json).toEqual([{ area: 'workspaces', state: 'done', count: 1 }])
    const none = firstLookRows(
      turn([bash('1', `${CLI} worktree ps --since 7d`), result('1', 'No worktrees found.\n')]),
      true
    )
    expect(none).toEqual([{ area: 'workspaces', state: 'done', count: 0 }])
  })

  it('counts empty plain lists as none', () => {
    const rows = firstLookRows(
      turn([
        bash('1', `${CLI} repo list`),
        result('1', 'No repos found.'),
        bash('2', `${CLI} linear list-issues --assignee me --state open --limit 50`),
        result('2', 'No Linear issues found.')
      ]),
      true
    )
    expect(rows).toEqual([
      { area: 'projects', state: 'done', count: 0, names: [] },
      { area: 'linear', state: 'done', count: 0 }
    ])
  })

  // The chat keeps only the first 16 KB of a tool's output, so its head can't be counted.
  it('shows a read whose output the chat cut as looked at, not as a wrong count', () => {
    const big = JSON.stringify(
      Array.from({ length: 400 }, (_, i) => ({
        url: `https://github.com/o/r/pull/${i}`
      }))
    )
    expect(big.length).toBeGreaterThan(16 * 1024)
    const rows = firstLookRows(
      turn([
        bash('1', 'gh search prs --author=@me --json url'),
        {
          type: 'tool-result',
          callId: '1',
          output: big.slice(0, 16 * 1024),
          isError: false,
          fullOutputItemId: 'item-1'
        },
        bash('2', `${CLI} linear list-issues --assignee me`),
        {
          type: 'tool-result',
          callId: '2',
          output: lines(300, (i) => `STA-${i}  Todo  me  A long issue title ${i}`).slice(
            0,
            16 * 1024
          ),
          isError: false,
          fullOutputItemId: 'item-2'
        },
        bash('3', `${CLI} repo list`),
        result('3', `${lines(3, (i) => `r${i}  repo${i}  /src/${i}`)}\n… (40000 bytes)`)
      ]),
      true
    )
    expect(rows).toEqual([
      { area: 'github', state: 'done' },
      { area: 'linear', state: 'done' },
      { area: 'projects', state: 'done' }
    ])
  })
})
