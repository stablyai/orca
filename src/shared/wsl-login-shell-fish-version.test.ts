import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildWslInteractiveLoginShellCommand } from './wsl-login-shell-command'

// A stub fish that reports a version and echoes the argv it was started with.
const root = mkdtempSync(join(tmpdir(), 'orca-wsl-fish-version-'))
const tools = join(root, 'tools')
const fish = join(root, 'bin', 'fish')
mkdirSync(tools)
mkdirSync(join(root, 'bin'))
writeFileSync(
  join(tools, 'getent'),
  `#!/bin/sh\nprintf '%s\\n' "user:x:1000:1000::/home/user:${fish}"\n`
)
writeFileSync(
  fish,
  [
    '#!/bin/sh',
    'if [ "$1" = --version ]; then',
    '  [ -n "$ORCA_TEST_FISH_VERSION" ] || exit 1',
    // fish 2.x writes its version to stderr.
    '  if [ -n "$ORCA_TEST_FISH_VERSION_ON_STDERR" ]; then',
    '    printf "%s\\n" "$ORCA_TEST_FISH_VERSION" >&2; exit 0',
    '  fi',
    '  printf "%s\\n" "$ORCA_TEST_FISH_VERSION"; exit 0',
    'fi',
    'printf "%s\\n" "$@"',
    ''
  ].join('\n')
)
chmodSync(join(tools, 'getent'), 0o755)
chmodSync(fish, 0o755)
afterAll(() => rmSync(root, { recursive: true, force: true }))

function startFlags(version: string, onStderr = false): string[] {
  const argv = execFileSync('/bin/sh', ['-c', buildWslInteractiveLoginShellCommand()], {
    encoding: 'utf8',
    env: {
      PATH: `${tools}:/usr/bin:/bin`,
      ORCA_TEST_FISH_VERSION: version,
      ...(onStderr ? { ORCA_TEST_FISH_VERSION_ON_STDERR: '1' } : {})
    }
  })
  return argv.split('\n').filter((arg) => arg === '-l' || arg === '-C')
}

// fish before 2.7 rejects -C, which failed the whole bridge pane (Ubuntu 16.04, Debian 9).
describe.skipIf(process.platform === 'win32')('a WSL bridge fish pane by fish version', () => {
  it.each(['fish, version 1.23.1', 'fish, version 2.2.0', 'fish, version 2.6.0'])(
    '%s starts plain, without -C',
    (version) => {
      expect(startFlags(version)).toEqual(['-l'])
    }
  )

  it('reads a fish 2.x version printed to stderr and starts plain', () => {
    expect(startFlags('fish, version 2.3.1', true)).toEqual(['-l'])
  })

  it.each([
    'fish, version 2.7.1',
    'fish, version 3.1.2',
    'fish, version 4.7.1',
    'fish, version 3.7.1-1234-gabcdef',
    // An unreadable version keeps today's launch.
    ''
  ])('%s starts with the -C init command', (version) => {
    expect(startFlags(version)).toEqual(['-l', '-C'])
  })
})
