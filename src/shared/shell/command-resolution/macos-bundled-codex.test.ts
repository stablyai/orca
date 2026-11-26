import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { resolveCliCommand, resolveCliCommands } from './node-cli-command-resolution'

function writeExecutable(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
}

it.skipIf(process.platform === 'win32')(
  'uses the macOS app CLI only after PATH and standalone installs',
  () => {
    const homePath = mkdtempSync(join(tmpdir(), 'orca-codex-app-'))
    try {
      const pathEnv = join(homePath, 'bin')
      const pathCodex = join(pathEnv, 'codex')
      const standaloneCodex = join(homePath, '.local', 'bin', 'codex')
      const appCodex = join(
        homePath,
        'Applications',
        'ChatGPT.app',
        'Contents',
        'Resources',
        'codex-cli',
        'bin',
        'codex'
      )
      writeExecutable(pathCodex)
      writeExecutable(standaloneCodex)
      writeExecutable(appCodex)
      const options = { platform: 'darwin' as const, homePath, pathEnv, codexAppFallback: true }

      expect(resolveCliCommand('codex', options)).toBe(pathCodex)
      rmSync(pathCodex)
      expect(resolveCliCommand('codex', options)).toBe(standaloneCodex)
      rmSync(standaloneCodex)
      expect(resolveCliCommand('codex', options)).toBe(appCodex)
      expect(resolveCliCommands(['codex'], { ...options, skipPathSearch: true }).get('codex')).toBe(
        appCodex
      )
    } finally {
      rmSync(homePath, { recursive: true, force: true })
    }
  }
)
