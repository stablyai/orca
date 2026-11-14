import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { escapeP4FileArg } from './p4-command'
import {
  requireChangelistId,
  requireChangelistTarget,
  requireDepotPaths,
  requireDescription,
  requireRelativePath,
  resolveInWorkspace
} from './perforce-arguments'

describe('perforce argument validation', () => {
  it('accepts workspace-relative paths only', () => {
    expect(requireRelativePath('src/a.txt')).toContain('a.txt')
    expect(() => requireRelativePath('../etc/passwd')).toThrow()
    expect(() => requireRelativePath('/etc/passwd')).toThrow()
    expect(() => requireRelativePath('a\0b')).toThrow()
  })

  it('answers with forward slashes, which every host and p4 accept', () => {
    // A Windows desktop checks the path, and a Linux SSH host or Orca server runs p4 with it.
    expect(requireRelativePath('src\\Game\\a.txt')).toBe('src/Game/a.txt')
    expect(requireRelativePath('./src//a.txt')).toBe('src/a.txt')
  })

  it('refuses Windows paths that leave the workspace on any host', () => {
    // Drive-relative: resolve('C:\\ws', 'C:..\\x') is C:\x, outside the workspace.
    expect(() => requireRelativePath('C:..\\..\\Windows\\System32\\drivers\\etc\\hosts')).toThrow()
    expect(() => requireRelativePath('C:foo.txt')).toThrow()
    expect(() => requireRelativePath('C:\\Windows\\win.ini')).toThrow()
    expect(() => requireRelativePath('\\\\server\\share\\a.txt')).toThrow()
    expect(() => requireRelativePath('src\\..\\..\\a.txt')).toThrow()
  })

  it('refuses the p4 recursive wildcard, which would widen a command to every file', () => {
    expect(() => requireRelativePath('...')).toThrow('"..."')
    expect(() => requireRelativePath('src/...')).toThrow('"..."')
    expect(() => escapeP4FileArg('a...b')).toThrow('"..."')
  })

  it('resolves only inside the workspace', () => {
    const root = resolve('ws')
    expect(resolveInWorkspace(root, 'src/a.txt')).toBe(join(root, 'src', 'a.txt'))
    expect(() => resolveInWorkspace(root, '.')).toThrow()
    expect(() => resolveInWorkspace(root, '../a.txt')).toThrow()
  })

  it('takes depot paths as p4 reports them, already escaped', () => {
    expect(requireDepotPaths(['//depot/main/a%40b.txt'])).toEqual(['//depot/main/a%40b.txt'])
    for (const widened of ['//depot/...', '//depot/*.txt', '//depot/a.txt@1', '//depot/a.txt#2']) {
      expect(() => requireDepotPaths([widened])).toThrow('Invalid Perforce depot path')
    }
  })

  it('validates changelist numbers and targets', () => {
    expect(requireChangelistId(7)).toBe(7)
    expect(() => requireChangelistId('7')).toThrow()
    expect(() => requireChangelistId(0)).toThrow()
    expect(requireChangelistTarget('default')).toBe('default')
  })

  it('requires non-blank descriptions', () => {
    expect(requireDescription('  hi ', 'Description')).toBe('hi')
    expect(() => requireDescription('   ', 'Description')).toThrow('Description is required')
  })
})
