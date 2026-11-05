import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildWslInteractiveLoginShellCommand } from './wsl-login-shell-command'

// A stub nu that echoes its argv and the config-related environment it was started with.
const root = mkdtempSync(join(tmpdir(), 'orca-wsl-nu-'))
const tools = join(root, 'tools')
const nu = join(root, 'bin', 'nu')
mkdirSync(tools)
mkdirSync(join(root, 'bin'))
writeFileSync(
  join(tools, 'getent'),
  `#!/bin/sh\nprintf '%s\\n' "user:x:1000:1000::/home/user:${nu}"\n`
)
writeFileSync(
  nu,
  [
    '#!/bin/sh',
    'printf "arg:%s\\n" "$@"',
    'printf "XDG_CONFIG_HOME:%s\\n" "${XDG_CONFIG_HOME-}"',
    ''
  ].join('\n')
)
chmodSync(join(tools, 'getent'), 0o755)
chmodSync(nu, 0o755)
afterAll(() => rmSync(root, { recursive: true, force: true }))

// nushell 0.94+ sends its own OSC 7 (shell_integration.osc7, on by default); the bridge must leave
// its config alone so that report survives.
describe.skipIf(process.platform === 'win32')('a WSL bridge nushell pane', () => {
  it('starts as a plain login shell with its own config', () => {
    const out = execFileSync('/bin/sh', ['-c', buildWslInteractiveLoginShellCommand()], {
      encoding: 'utf8',
      env: { PATH: `${tools}:/usr/bin:/bin` }
    })
    expect(out.trim().split('\n')).toEqual(['arg:-l', 'XDG_CONFIG_HOME:'])
  })
})
