import { expect, it } from 'vitest'
import {
  ACCOUNT_IMPORT_RUNTIME_CAPABILITY,
  CODEX_ACCOUNT_IMPORT_CAPABILITY,
  CLAUDE_PROFILE_LOGIN_CAPABILITY
} from './account-runtime-capabilities'
import { RUNTIME_CAPABILITIES } from './protocol-version'
import {
  buildWslInteractiveLoginShellCommand,
  buildWslCapturedLoginShellCommand
} from './wsl-login-shell-command'
import { getFishClaudeShellFunction } from './claude-shell-function'
it('withdraws the shared import capability before an old CLI can start either login', () => {
  expect([...RUNTIME_CAPABILITIES]).not.toContain(ACCOUNT_IMPORT_RUNTIME_CAPABILITY)
  expect([...RUNTIME_CAPABILITIES]).toContain(CODEX_ACCOUNT_IMPORT_CAPABILITY)
  expect([...RUNTIME_CAPABILITIES]).toContain(CLAUDE_PROFILE_LOGIN_CAPABILITY)
})
it('injects the pointer-reading function when fish is the WSL login shell without executing a shell', () => {
  const command = buildWslInteractiveLoginShellCommand()
  expect(command).toContain('fish)')
  expect(command).toContain('"$_orca_wsl_shell" -l -C')
  expect(getFishClaudeShellFunction()).toContain('ORCA_CLAUDE_PROFILE_POINTER')
  expect(command).toContain('Claude account selection is unreadable')
})

it('keeps fish login PATH while handing captured POSIX payloads to sh, without executing them', () => {
  const capture = buildWslCapturedLoginShellCommand('fake-claude auth status --json', 'fake')
  expect(capture.command).toContain(
    `fish) exec "$_orca_wsl_shell" -ilc 'exec /bin/sh -c "$argv[1]"' --`
  )
  expect(capture.command).toContain('fake-claude auth status --json')
})
