import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { getSpawnArgsForWindows } from './windows-batch-spawn'

// Argv shape cannot show this bug: cmd.exe re-parses the line libuv builds, so only a real spawn proves it.
it.skipIf(process.platform !== 'win32')(
  'runs a spaced .cmd launcher with spaced and /? arguments intact',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-batch-spawn-'))
    try {
      const launcherDir = join(root, 'Launcher Dir (x86)')
      mkdirSync(launcherDir)
      const launcher = join(launcherDir, 'edit.cmd')
      const capture = join(root, 'argv.txt')
      writeFileSync(
        launcher,
        [
          '@echo off',
          ':loop',
          'if "%~1"=="" exit /b 7',
          `echo arg=%~1>>"${capture}"`,
          'shift',
          'goto loop',
          ''
        ].join('\r\n')
      )
      const workspace = join(root, 'Desktop Folder', 'my project')

      const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(launcher, [workspace, '/?'])
      const result = spawnSync(spawnCmd, spawnArgs, { windowsHide: true, encoding: 'utf8' })

      expect(result.stderr).toBe('')
      expect(result.status).toBe(7)
      expect(readFileSync(capture, 'utf8').trim().split(/\r?\n/)).toEqual([
        `arg=${workspace}`,
        'arg=/?'
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)
