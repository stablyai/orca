import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  buildJcodeRuntimeDir,
  buildJcodeRuntimeDirEnv,
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
    expect(dir).toMatch(/orca-jcode\/[0-9a-f]{16}$/)
    expect(buildJcodeRuntimeDir(paneKey)).toBe(dir)
  })

  it('keeps the socket path under the unix SUN_LEN cap', () => {
    const longTmp = '/var/folders/1g/mx9qj46x02qbqd7rh4xx_s8c0000gn/T'
    const paneKey = `${'a'.repeat(36)}:${'b'.repeat(36)}`
    const hash = buildJcodeRuntimeDir(paneKey).split('/').pop() ?? ''
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
})
