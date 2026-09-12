import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getWindowsPowerShellShimSpawn } from './windows-powershell-shim-spawn'

describe('getWindowsPowerShellShimSpawn', () => {
  it('returns null unless a sibling .ps1 exists for a .cmd/.bat command', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-ps1-shim-missing-'))
    try {
      const batchShim = join(tempDir, 'cursor-agent.cmd')
      writeFileSync(batchShim, '@echo off\r\n')
      expect(
        getWindowsPowerShellShimSpawn(batchShim, ['--print'], { SystemRoot: 'C:\\Windows' })
      ).toBe(null)
      expect(
        getWindowsPowerShellShimSpawn(join(tempDir, 'cursor-agent.exe'), ['--print'], {
          SystemRoot: 'C:\\Windows'
        })
      ).toBe(null)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('spawns powershell -File with the sibling shim and the original argv', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-ps1-shim-file-'))
    const batchShim = join(tempDir, 'cursor-agent.cmd')
    const powerShellShim = join(tempDir, 'cursor-agent.ps1')
    writeFileSync(batchShim, '@echo off\r\n')
    writeFileSync(powerShellShim, 'exit 0\r\n')
    try {
      const spawn = getWindowsPowerShellShimSpawn(
        batchShim,
        ['--print', 'line one\nline two & calc.exe'],
        { SystemRoot: 'D:\\Windows' }
      )
      expect(spawn).toEqual({
        spawnCmd: 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        spawnArgs: [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          powerShellShim,
          '--print',
          'line one\nline two & calc.exe'
        ]
      })
      expect(spawn?.spawnArgs).not.toContain('-Command')
      expect(spawn?.spawnCmd.toLowerCase()).not.toContain('cmd.exe')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('falls back to C:\\Windows when SystemRoot is not a drive path', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-ps1-shim-root-'))
    const batchShim = join(tempDir, 'agent.bat')
    const powerShellShim = join(tempDir, 'agent.ps1')
    writeFileSync(batchShim, '@echo off\r\n')
    writeFileSync(powerShellShim, 'exit 0\r\n')
    try {
      expect(
        getWindowsPowerShellShimSpawn(batchShim, ['--version'], {
          SystemRoot: '\\\\server\\share'
        })?.spawnCmd
      ).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
