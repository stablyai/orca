import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginOverlayManager } from '../overlays/plugin-overlay'

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
})
