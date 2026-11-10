import { describe, expect, it } from 'vitest'
import {
  nativeChatShellBlocksWithoutFences,
  nativeChatShellCommand,
  nativeChatShellCommandBlock
} from './native-chat-shell-command'

describe('nativeChatShellCommand', () => {
  it.each([
    ['!git status', 'git status'],
    ['! git status', 'git status'],
    ['!  ls -la  ', 'ls -la']
  ])('reads %s as a shell command', (draft, command) => {
    expect(nativeChatShellCommand(draft)).toBe(command)
  })

  it.each(['git status', ' !pwd', '!', '! ', 'hello !pwd'])('leaves %j as a message', (draft) => {
    expect(nativeChatShellCommand(draft)).toBeNull()
  })
})

describe('nativeChatShellCommandBlock', () => {
  it('shows the command, output and a failing exit code', () => {
    expect(
      nativeChatShellCommandBlock('ls nope', {
        output: 'ls: nope: No such file or directory\n',
        exitCode: 1,
        timedOut: false,
        outputTruncated: false,
        directory: null
      })
    ).toBe('```console\n$ ls nope\nls: nope: No such file or directory\n[exit 1]\n```')
  })

  it('tells the agent when output was cut or the command timed out', () => {
    expect(
      nativeChatShellCommandBlock('yes', {
        output: 'y\n',
        exitCode: null,
        timedOut: true,
        outputTruncated: true,
        directory: null
      })
    ).toBe(
      '```console\n$ yes\n[output truncated to the last 64 KB]\ny\n[timed out after 120s]\n```'
    )
  })

  it('sends the agent only the last 64 KB of a long output, from a line start', () => {
    const block = nativeChatShellCommandBlock('yes a', {
      output: 'a\n'.repeat(40000),
      exitCode: 0,
      timedOut: false,
      outputTruncated: false,
      directory: null
    })
    const lines = block.split('\n')
    expect(lines.slice(0, 3)).toEqual([
      '```console',
      '$ yes a',
      '[output truncated to the last 64 KB]'
    ])
    expect(lines.filter((line) => line === 'a')).toHaveLength(32768)
  })

  it('names the directory and a stopped run', () => {
    expect(
      nativeChatShellCommandBlock('npm test', {
        output: 'running\n',
        exitCode: null,
        timedOut: false,
        outputTruncated: false,
        stopped: true,
        directory: 'packages/app'
      })
    ).toBe('```console\n$ npm test\n[in packages/app]\nrunning\n[stopped]\n```')
  })

  it('lengthens the fence past backticks in the output', () => {
    expect(
      nativeChatShellCommandBlock('cat README.md', {
        output: '```ts\nx\n```\n',
        exitCode: 0,
        timedOut: false,
        outputTruncated: false,
        directory: null
      })
    ).toBe('````console\n$ cat README.md\n```ts\nx\n```\n````')
  })
})

describe('nativeChatShellBlocksWithoutFences', () => {
  it('unwraps a shell block and keeps a literal fence line inside it', () => {
    expect(
      nativeChatShellBlocksWithoutFences('explain\n\n````console\n$ cat a.md\n```\nx\n```\n````')
    ).toBe('explain\n\n$ cat a.md\n```\nx\n```')
  })

  it('leaves code blocks the user wrote untouched', () => {
    expect(nativeChatShellBlocksWithoutFences('see\n```ts\nconst a = 1\n```')).toBe(
      'see\n```ts\nconst a = 1\n```'
    )
  })
})
