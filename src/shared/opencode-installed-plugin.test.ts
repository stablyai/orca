import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isInstalledOpenCodePluginCurrent,
  isOverlayOpenCodePluginCurrent
} from './opencode-installed-plugin'

describe('installed OpenCode plugin currency', () => {
  let dir: string
  let pluginPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-opencode-installed-plugin-'))
    pluginPath = join(dir, 'orca-opencode-status.js')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('treats a missing or different file as stale', () => {
    expect(isInstalledOpenCodePluginCurrent(pluginPath, 'plugin')).toBe(false)
    expect(isOverlayOpenCodePluginCurrent(pluginPath, 'plugin')).toBe(false)
    writeFileSync(pluginPath, 'older plugin')
    expect(isInstalledOpenCodePluginCurrent(pluginPath, 'plugin')).toBe(false)
    expect(isOverlayOpenCodePluginCurrent(pluginPath, 'plugin')).toBe(false)
  })

  it('treats a regular file with the same bytes as current', () => {
    writeFileSync(pluginPath, 'plugin')
    expect(isInstalledOpenCodePluginCurrent(pluginPath, 'plugin')).toBe(true)
    expect(isOverlayOpenCodePluginCurrent(pluginPath, 'plugin')).toBe(true)
  })

  it.skipIf(process.platform === 'win32')(
    'follows a symlink except in an overlay, where a link is a mirrored user entry',
    () => {
      const targetPath = join(dir, 'target.js')
      writeFileSync(targetPath, 'plugin')
      symlinkSync(targetPath, pluginPath)
      expect(isInstalledOpenCodePluginCurrent(pluginPath, 'plugin')).toBe(true)
      expect(isOverlayOpenCodePluginCurrent(pluginPath, 'plugin')).toBe(false)
    }
  )
})
