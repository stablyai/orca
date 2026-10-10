import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetShellStartupEnvCache } from '../main/pty/shell-startup-env'
import { resolveOpenCodeSourceConfigDir, resolvePiSourceAgentDir } from './plugin-overlay-env'

describe('plugin overlay env source resolution', () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'relay-plugin-overlay-env-'))
    __resetShellStartupEnvCache()
  })

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true })
    __resetShellStartupEnvCache()
  })

  it.skipIf(process.platform === 'win32')(
    'uses zsh startup exports before inherited public overlay env',
    () => {
      mkdirSync(join(homeDir, 'company-opencode'), { recursive: true })
      mkdirSync(join(homeDir, 'company-pi'), { recursive: true })
      writeFileSync(
        join(homeDir, '.zshrc'),
        [
          'export OPENCODE_CONFIG_DIR="$HOME/company-opencode"',
          'export PI_CODING_AGENT_DIR="$HOME/company-pi"'
        ].join('\n')
      )

      const env = {
        HOME: homeDir,
        OPENCODE_CONFIG_DIR: '/tmp/inherited-opencode-overlay',
        PI_CODING_AGENT_DIR: '/tmp/inherited-pi-overlay'
      }

      expect(resolveOpenCodeSourceConfigDir(env, '/bin/zsh')).toBe(
        join(homeDir, 'company-opencode')
      )
      expect(resolvePiSourceAgentDir(env, '/bin/zsh', 'pi')).toBe(join(homeDir, 'company-pi'))
    }
  )

  it.skipIf(process.platform === 'win32')(
    'discovers overlay sources from a custom zsh ZDOTDIR',
    () => {
      const zshDir = join(homeDir, '.config', 'zsh')
      mkdirSync(zshDir, { recursive: true })
      writeFileSync(join(homeDir, '.zshenv'), 'export ZDOTDIR="$HOME/.config/zsh"\n')
      writeFileSync(join(zshDir, '.zshrc'), 'export OPENCODE_CONFIG_DIR="$HOME/opencode-src"\n')

      expect(
        resolveOpenCodeSourceConfigDir(
          {
            HOME: homeDir,
            OPENCODE_CONFIG_DIR: '/tmp/inherited-opencode-overlay'
          },
          '/bin/zsh'
        )
      ).toBe(join(homeDir, 'opencode-src'))
    }
  )

  it('keeps explicit original-source env ahead of startup hints', () => {
    writeFileSync(join(homeDir, '.zshrc'), 'export OPENCODE_CONFIG_DIR="$HOME/company-opencode"\n')

    expect(
      resolveOpenCodeSourceConfigDir(
        {
          HOME: homeDir,
          ORCA_OPENCODE_SOURCE_CONFIG_DIR: '/remote/original-opencode',
          OPENCODE_CONFIG_DIR: '/tmp/inherited-opencode-overlay'
        },
        '/bin/zsh'
      )
    ).toBe('/remote/original-opencode')
  })

  it.skipIf(process.platform === 'win32')('resolves Prime from its independent env keys', () => {
    writeFileSync(
      join(homeDir, '.zshrc'),
      'export PRIME_AGENT_CODING_AGENT_DIR="$HOME/company-prime"\n'
    )

    expect(
      resolvePiSourceAgentDir(
        { HOME: homeDir, PRIME_AGENT_CODING_AGENT_DIR: '/tmp/inherited-prime' },
        '/bin/zsh',
        'prime-agent'
      )
    ).toBe(join(homeDir, 'company-prime'))
    expect(
      resolvePiSourceAgentDir(
        {
          HOME: homeDir,
          ORCA_PRIME_AGENT_SOURCE_AGENT_DIR: '/remote/original-prime',
          PRIME_AGENT_CODING_AGENT_DIR: '/tmp/inherited-prime'
        },
        '/bin/zsh',
        'prime-agent'
      )
    ).toBe('/remote/original-prime')
  })

  // Why: the session env is the only place a fish user's XDG_CONFIG_HOME shows up
  // (config.fish exports it, so no GUI-launched process inherits it). Dropping it
  // here would scan ~/.config and disagree with the same lookup on the main side.
  it.skipIf(process.platform === 'win32')(
    'reads fish config under the session XDG_CONFIG_HOME',
    () => {
      const configHome = join(homeDir, 'xdg')
      mkdirSync(join(configHome, 'fish'), { recursive: true })
      writeFileSync(
        join(configHome, 'fish', 'config.fish'),
        'set -gx OPENCODE_CONFIG_DIR "$HOME/company-opencode"\n'
      )
      mkdirSync(join(homeDir, '.config', 'fish'), { recursive: true })
      writeFileSync(
        join(homeDir, '.config', 'fish', 'config.fish'),
        'set -gx OPENCODE_CONFIG_DIR /wrong-default-config-home\n'
      )

      expect(
        resolveOpenCodeSourceConfigDir(
          { HOME: homeDir, XDG_CONFIG_HOME: configHome },
          '/opt/homebrew/bin/fish'
        )
      ).toBe(join(homeDir, 'company-opencode'))
    }
  )
})
