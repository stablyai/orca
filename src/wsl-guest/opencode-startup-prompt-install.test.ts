import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginOverlayManager } from './plugin-overlay'
import { createInstallPluginsHandler } from './wsl-install-plugins-handler'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relay-prompt-install-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})
const promptPath = (config: string) =>
  join(config, 'plugins', 'orca-opencode-startup-prompt', 'tui.js')
describe('execution-host startup prompt installation', () => {
  it('caches prompt source independently and revokes future installs with an empty source', () => {
    const manager = new PluginOverlayManager({ homeDir: root })
    const config = join(root, 'custom')
    manager.setSources({ opencodeStartupPromptSource: 'prompt source' })
    expect(manager.hasOpenCodeSource()).toBe(false)
    expect(manager.installOpenCodeStartupPromptPlugin({}, config)).toBe(true)
    manager.setSources({ opencodePluginSource: '' })
    expect(manager.installOpenCodeStartupPromptPlugin({}, config)).toBe(true)
    expect(readFileSync(promptPath(config), 'utf8')).toBe('prompt source')
    manager.setSources({ opencodeStartupPromptSource: '' })
    expect(manager.installOpenCodeStartupPromptPlugin({}, join(root, 'not-installed'))).toBe(false)
    expect(existsSync(join(root, 'not-installed'))).toBe(false)
  })
  it('materializes a prompt-only overlay without overwriting a same-named user plugin', () => {
    const manager = new PluginOverlayManager({ homeDir: root })
    const config = join(root, 'custom')
    mkdirSync(join(config, 'plugins', 'orca-opencode-startup-prompt'), { recursive: true })
    writeFileSync(promptPath(config), 'user collision')
    writeFileSync(join(config, 'opencode.json'), '{"model":"user/model"}')
    manager.setSources({ opencodeStartupPromptSource: 'prompt source' })
    const overlay = manager.materializeOpenCode('pane', config)
    if (!overlay) {
      throw new Error('Missing prompt overlay')
    }
    expect(readFileSync(promptPath(overlay), 'utf8')).toBe('prompt source')
    expect(readFileSync(promptPath(config), 'utf8')).toBe('user collision')
    expect(readFileSync(join(overlay, 'opencode.json'), 'utf8')).toContain('user/model')
    expect(existsSync(join(overlay, 'plugins', 'orca-opencode-status.js'))).toBe(false)
  })
  it('installs through WSL with both status sources disabled and preserves explicit config', () => {
    const config = join(root, 'custom')
    const manager = new PluginOverlayManager({ homeDir: root })
    const install = createInstallPluginsHandler(manager, {
      HOME: root,
      OPENCODE_CONFIG_DIR: config
    })
    const result = install({
      opencodeStartupPromptSource: 'first',
      opencodePluginSource: '',
      opencode2PluginSource: ''
    })
    expect(result.installed).toMatchObject({
      opencodeStartupPrompt: true,
      opencode: false,
      opencode2: false
    })
    expect(result.overlayDirs).toEqual({})
    expect(readFileSync(promptPath(config), 'utf8')).toBe('first')
    install({ opencodeStartupPromptSource: 'second' })
    expect(readFileSync(promptPath(config), 'utf8')).toBe('second')
  })
  it('refreshes prompt source in both cached status overlays without rebuilding them', () => {
    const manager = new PluginOverlayManager({ homeDir: root })
    const install = createInstallPluginsHandler(manager, { HOME: root })
    const first = install({
      opencodeStartupPromptSource: 'first',
      opencodePluginSource: 'status v1',
      opencode2PluginSource: 'status v2'
    })
    const second = install({ opencodeStartupPromptSource: 'second' })
    expect(second.overlayDirs).toEqual(first.overlayDirs)
    for (const config of [second.overlayDirs.opencode, second.overlayDirs.opencode2]) {
      if (!config) {
        throw new Error('Missing status overlay')
      }
      expect(readFileSync(promptPath(config), 'utf8')).toBe('second')
    }
  })
})
