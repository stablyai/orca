import { describe, expect, it } from 'vitest'
import { journalItemHasSideEffects, toolCallHasSideEffects } from './tool-call-side-effects'

// The thread's "check before asking again" note and the hidden retry both hang on this: a call that
// may have acted must never pass as a read.
describe('toolCallHasSideEffects', () => {
  it('passes only calls known to read', () => {
    const reads: [string, unknown][] = [
      ['Read', { file_path: 'a.ts' }],
      ['Grep', { pattern: 'x' }],
      ['WebFetch', { url: 'https://example.com' }],
      ['Bash', { command: 'git log --oneline -5 && rg -n foo src | head' }],
      ['Bash', { command: 'gh pr view 12 --json state 2>&1' }],
      ['Bash', { command: '"${ORCA_CLI_COMMAND:-orca}" bot item show 4' }],
      ['shell', { command: "/bin/zsh -lc 'cat a.txt'" }],
      ['read', { command: "bash -lc 'sed -n 1,20p a.ts'" }],
      ['read_file', { path: 'a.ts' }]
    ]
    const acts: [string, unknown][] = [
      ['Edit', { file_path: 'a.ts' }],
      ['apply_patch', { changes: [] }],
      ['Task', { prompt: 'fix it' }],
      ['slack/post_message', { text: 'hi' }],
      ['Bash', { command: 'echo hi > a.txt' }],
      ['Bash', { command: 'cat a && rm -rf b' }],
      ['Bash', { command: 'sed -i s/a/b/ a.ts' }],
      ['Bash', { command: 'find . -name x -delete' }],
      ['Bash', { command: 'gh api repos/o/r/issues -f title=x' }],
      ['Bash', { command: 'git -c core.pager=x log' }],
      ['Bash', { command: 'git push' }],
      ['Bash', { command: '"${ORCA_CLI_COMMAND:-orca}" bot reply --text hi' }],
      ['read', { command: "bash -lc 'cat a; npm install'" }],
      ['Bash', { command: 'cat $(make)' }],
      ['Bash', {}],
      ['Bash', { command: 'diff <(rm -rf x) a' }],
      ['Bash', { command: "sed -n '1w /tmp/x' a" }],
      ['Bash', { command: 'sort -uo out in' }],
      ['Bash', { command: 'orca orchestration check' }],
      ['Bash', { command: 'cat a > /dev/nullx' }]
    ]
    expect(reads.filter(([name, input]) => toolCallHasSideEffects(name, input))).toEqual([])
    expect(acts.filter(([name, input]) => !toolCallHasSideEffects(name, input))).toEqual([])
    expect(journalItemHasSideEffects({ kind: 'diff' })).toBe(true)
  })
})
