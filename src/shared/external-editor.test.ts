import { describe, expect, it } from 'vitest'
import { formatExternalEditorOpenTarget } from './external-editor'

describe('formatExternalEditorOpenTarget', () => {
  it('formats VS Code CLI targets with line and column', () => {
    expect(
      formatExternalEditorOpenTarget(
        { kind: 'vscode', strategy: 'cli' },
        { filePath: '/repo/src/main.ts', line: 12, column: 5 }
      )
    ).toEqual({
      kind: 'cli',
      command: 'code',
      args: ['-g', '/repo/src/main.ts:12:5']
    })
  })

  it('defaults missing line and column to one', () => {
    expect(
      formatExternalEditorOpenTarget(
        { kind: 'vscode', strategy: 'cli' },
        { filePath: '/repo/src/main.ts' }
      )
    ).toEqual({
      kind: 'cli',
      command: 'code',
      args: ['-g', '/repo/src/main.ts:1:1']
    })
  })

  it('normalizes invalid line and column values to one', () => {
    expect(
      formatExternalEditorOpenTarget(
        { kind: 'vscode', strategy: 'cli' },
        { filePath: '/repo/src/main.ts', line: 0, column: Number.NaN }
      )
    ).toEqual({
      kind: 'cli',
      command: 'code',
      args: ['-g', '/repo/src/main.ts:1:1']
    })
  })

  it('formats JetBrains CLI targets with line and column flags', () => {
    expect(
      formatExternalEditorOpenTarget(
        { kind: 'jetbrains-idea', strategy: 'cli' },
        { filePath: '/repo/src/main.ts', line: 7, column: 3 }
      )
    ).toEqual({
      kind: 'cli',
      command: 'idea',
      args: ['--line', '7', '--column', '3', '/repo/src/main.ts']
    })
  })

  it('keeps custom args as separate argv entries', () => {
    expect(
      formatExternalEditorOpenTarget(
        {
          kind: 'custom',
          strategy: 'cli',
          command: 'my-editor',
          argsTemplate: ['--goto', '{path}:{line}:{column}']
        },
        { filePath: '/repo/a file; rm -rf nope.ts', line: 2, column: 4 }
      )
    ).toEqual({
      kind: 'cli',
      command: 'my-editor',
      args: ['--goto', '/repo/a file; rm -rf nope.ts:2:4']
    })
  })

  it('formats custom URL templates with pathEncoded', () => {
    expect(
      formatExternalEditorOpenTarget(
        {
          kind: 'custom',
          strategy: 'url',
          urlTemplate: 'vscode://file/{pathEncoded}:{line}:{column}'
        },
        { filePath: '/repo/a file.ts', line: 10, column: 9 }
      )
    ).toEqual({
      kind: 'url',
      url: 'vscode://file/%2Frepo%2Fa%20file.ts:10:9'
    })
  })

  it('rejects unknown editor kinds', () => {
    expect(
      formatExternalEditorOpenTarget({ kind: 'zed', strategy: 'cli' } as never, {
        filePath: '/repo/src/main.ts'
      })
    ).toBeNull()
  })
})
