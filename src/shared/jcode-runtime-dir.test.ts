import { describe, expect, it } from 'vitest'
import { rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  buildJcodeRuntimeDir,
  buildJcodeRuntimeDirEnv,
  ensureJcodeRuntimeDir,
  JCODE_RUNTIME_DIR_ENV_KEY,
  shouldInjectJcodeRuntimeDir
} from './jcode-runtime-dir'

// Why: unix socket paths are capped at SUN_LEN (104 bytes); the socket file is
// `<runtimeDir>/jcode.sock`, so the runtime dir itself must stay far below it
// even on machines with long TMPDIR values.
const SUN_LEN_LIMIT = 104

describe('shared jcode-runtime-dir', () => {
  it('derives a short deterministic hash per pane', () => {
    const paneKey = 'tab-abc:leaf-123'
    const dir = buildJcodeRuntimeDir(paneKey)
    expect(basename(dir)).toMatch(/^[0-9a-f]{16}$/)
    expect(buildJcodeRuntimeDir(paneKey)).toBe(dir)
  })

  it('keeps the socket path under the unix SUN_LEN cap', () => {
    const longTmp = '/var/folders/1g/mx9qj46x02qbqd7rh4xx_s8c0000gn/T'
    const paneKey = `${'a'.repeat(36)}:${'b'.repeat(36)}`
    const hash = basename(buildJcodeRuntimeDir(paneKey))
    const socketPath = join(longTmp, 'orca-jcode', hash, 'jcode.sock')
    expect(socketPath.length).toBeLessThan(SUN_LEN_LIMIT)
  })

  it('keeps runtime dirs distinct across panes', () => {
    expect(buildJcodeRuntimeDir('tab-a:leaf-1')).not.toBe(buildJcodeRuntimeDir('tab-a:leaf-2'))
  })

  it('builds the env only on unix platforms', () => {
    expect(buildJcodeRuntimeDirEnv('tab-a:leaf-b', 'darwin')).toEqual({
      [JCODE_RUNTIME_DIR_ENV_KEY]: buildJcodeRuntimeDir('tab-a:leaf-b')
    })
    expect(buildJcodeRuntimeDirEnv('tab-a:leaf-b', 'linux')).toBeDefined()
    expect(buildJcodeRuntimeDirEnv('tab-a:leaf-b', 'win32')).toBeUndefined()
    expect(shouldInjectJcodeRuntimeDir('win32')).toBe(false)
  })

  it('ensures the runtime dir exists and returns the env on unix', async () => {
    const paneKey = 'tab-a:leaf-c'
    const dir = buildJcodeRuntimeDir(paneKey)
    const env = await ensureJcodeRuntimeDir(paneKey, 'darwin')
    expect(env).toEqual({ [JCODE_RUNTIME_DIR_ENV_KEY]: dir })
    expect((await stat(dir)).isDirectory()).toBe(true)
    // Why: unsupported platforms must stay no-ops (no dir, no env).
    expect(await ensureJcodeRuntimeDir(paneKey, 'win32')).toBeUndefined()
    await rm(dir, { recursive: true, force: true })
  })
})
