// Run off Windows: guest overlays use POSIX home paths; live Windows-to-WSL coverage belongs to the rig.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { PluginOverlayManager } from '../overlays/plugin-overlay'
import { createInstallPluginsHandler } from './wsl-install-plugins-handler'
import { PLUGIN_SOURCE_MAX_BYTES } from './plugin-source-limit'

describe.skipIf(process.platform === 'win32')('createInstallPluginsHandler (guest side)', () => {
  function freshHome(): string {
    return mkdtempSync(join(tmpdir(), 'wsl-guest-home-'))
  }

  function withHome(run: (home: string) => void): void {
    const home = freshHome()
    try {
      run(home)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  function requireOverlayDir(dir: string | undefined): string {
    if (typeof dir !== 'string') {
      throw new Error('expected the handler to return an overlay dir')
    }
    return dir
  }

  it('scopes opted-in Claude mods to versioned relay storage and remembers shortcut removal', () => {
    withHome((home) => {
      const config = join(home, 'claude-profile')
      const install = createInstallPluginsHandler(new PluginOverlayManager({ homeDir: home }), {
        HOME: home,
        CLAUDE_CONFIG_DIR: config,
        ORCA_WSL_HOOK_INSTANCE: 'claude-test'
      })
      expect(install({ claudeAgentViewSource: '' }).overlayDirs.claudeAgentView).toBeUndefined()
      expect(existsSync(config)).toBe(false)
      const source = 'export function register() {}'
      const first = install({ claudeAgentViewSource: source }).overlayDirs.claudeAgentView
      if (!first) {
        throw new Error('Claude mod was not installed')
      }
      expect(first.startsWith(join(home, '.orca-relay'))).toBe(true)
      expect(readFileSync(join(first, 'hooks', 'register.js'), 'utf8')).toBe(source)
      expect(existsSync(join(config, 'skills'))).toBe(false)
      const second = install({ claudeAgentViewSource: `${source}\n// new version` }).overlayDirs
        .claudeAgentView
      expect(second).not.toBe(first)
      expect(readFileSync(join(first, 'hooks', 'register.js'), 'utf8')).toBe(source)
      expect(install({ claudeAgentViewSource: '' }).overlayDirs.claudeAgentView).toBeUndefined()
      expect(JSON.parse(readFileSync(join(config, 'keybindings.json'), 'utf8')).bindings).toEqual(
        []
      )
      expect(install({ claudeAgentViewSource: source }).overlayDirs.claudeAgentView).toBe(first)
      writeFileSync(join(config, 'keybindings.json'), '{"bindings": []}')
      install({ claudeAgentViewSource: '' })
      expect(install({ claudeAgentViewSource: source }).overlayDirs.claudeAgentView).toBeUndefined()
      expect(readFileSync(join(config, 'keybindings.json'), 'utf8')).toBe('{"bindings": []}')
    })
  })

  it('reuses the overlay on repeat installs instead of rebuilding it', () => {
    withHome((home) => {
      const install = createInstallPluginsHandler(new PluginOverlayManager({ homeDir: home }), {
        HOME: home,
        ORCA_WSL_HOOK_INSTANCE: 'inst1'
      })
      const source = '// v1\n'
      const dir = requireOverlayDir(install({ opencodePluginSource: source }).overlayDirs.opencode)

      // Keep the existing config root under running agents; a wipe/rebuild would remove this canary.
      const canary = join(dir, 'opencode.json')
      writeFileSync(canary, '{"model":"user-set"}')

      expect(install({ opencodePluginSource: source }).overlayDirs.opencode).toBe(dir)
      expect(install({}).overlayDirs.opencode).toBe(dir)
      expect(existsSync(canary)).toBe(true)
    })
  })

  it('mirrors an explicitly-set config root so overriding the var does not drop it', () => {
    withHome((home) => {
      // Why: setting OPENCODE_CONFIG_DIR to the overlay removes the user's own value
      // from OpenCode's config-dir list, so that one must be mirrored in.
      const userConfig = join(home, 'my-opencode')
      mkdirSync(userConfig, { recursive: true })
      writeFileSync(join(userConfig, 'opencode.json'), '{"model":"user-set"}')
      const install = createInstallPluginsHandler(new PluginOverlayManager({ homeDir: home }), {
        HOME: home,
        ORCA_OPENCODE_SOURCE_CONFIG_DIR: userConfig,
        ORCA_WSL_HOOK_INSTANCE: 'inst1'
      })
      const dir = requireOverlayDir(
        install({ opencodePluginSource: '// v1\n' }).overlayDirs.opencode
      )

      expect(readFileSync(join(dir, 'opencode.json'), 'utf8')).toBe('{"model":"user-set"}')
      expect(existsSync(join(dir, 'plugins', 'orca-opencode-status.js'))).toBe(true)
    })
  })

  it('rejects a source that exceeds the byte cap before writing anything', () => {
    withHome((home) => {
      const overlay = new PluginOverlayManager({ homeDir: home })
      const install = createInstallPluginsHandler(overlay, {
        HOME: home
      })
      const tooBig = 'a'.repeat(PLUGIN_SOURCE_MAX_BYTES + 1)
      expect(() => install({ opencodePluginSource: tooBig })).toThrow(/byte cap/)
      expect(overlay.hasOpenCodeSource()).toBe(false)
    })
  })
})
