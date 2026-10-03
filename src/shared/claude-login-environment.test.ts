import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeLoginHostEnv, claudeLoginWslScript } from './claude-login-environment'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

describe('Claude login environment', () => {
  it('drops inherited credentials and auth headers but keeps other custom headers', () => {
    const base = {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'fake',
      CLAUDE_CODE_OAUTH_TOKEN: 'fake',
      ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer fake'
    }
    expect(claudeLoginHostEnv(base, '/profile', 'darwin')).toEqual({
      PATH: '/usr/bin',
      CLAUDE_CONFIG_DIR: '/profile',
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '/profile'
    })
    expect(
      claudeLoginHostEnv({ ANTHROPIC_CUSTOM_HEADERS: 'X-Trace: 1' }, '/profile', 'darwin')
    ).toMatchObject({ ANTHROPIC_CUSTOM_HEADERS: 'X-Trace: 1' })
    expect(claudeLoginHostEnv({ anthropic_api_key: 'fake' }, 'C:\\p', 'win32')).toEqual({
      CLAUDE_CONFIG_DIR: 'C:\\p',
      CLAUDE_SECURESTORAGE_CONFIG_DIR: 'C:\\p'
    })
  })

  it('applies the same rule inside a POSIX guest shell', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-login-env-'))
    roots.push(root)
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const fake = join(bin, 'claude')
    writeFileSync(
      fake,
      '#!/bin/sh\nprintf "%s|%s|%s|%s|%s\\n" "$CLAUDE_CONFIG_DIR" "$CLAUDE_SECURESTORAGE_CONFIG_DIR" "${ANTHROPIC_API_KEY-none}" "${ANTHROPIC_CUSTOM_HEADERS-none}" "$*"\n'
    )
    chmodSync(fake, 0o700)
    const run = (headers: string) =>
      spawnSync(
        '/usr/bin/env',
        [
          '-i',
          `HOME=${root}`,
          `PATH=${bin}:/usr/bin:/bin`,
          'ANTHROPIC_API_KEY=fake',
          `ANTHROPIC_CUSTOM_HEADERS=${headers}`,
          '/bin/sh',
          '-c',
          `[ "$(command -v claude)" = '${fake}' ] || exit 97\n${claudeLoginWslScript("/home/me/it's", ['auth', 'login'])}`
        ],
        { encoding: 'utf8', cwd: root }
      )
    expect(run('authorization: Bearer fake').stdout).toBe(
      "/home/me/it's|/home/me/it's|none|none|auth login\n"
    )
    expect(run('X-Trace: 1').stdout).toBe(
      "/home/me/it's|/home/me/it's|none|X-Trace: 1|auth login\n"
    )
  })
})
