import { expect, it } from 'vitest'
import { CLAUDE_SIGN_IN_RUNTIME_CAPABILITY, RUNTIME_CAPABILITIES } from './protocol-version'
import {
  buildWslInteractiveLoginShellCommand,
  buildWslLoginShellCommand
} from './wsl-login-shell-command'
import { getFishClaudeShellFunction } from './claude-shell-function'

it('advertises the Claude sign-in the CLI needs before it starts a login', () => {
  expect([...RUNTIME_CAPABILITIES]).toContain(CLAUDE_SIGN_IN_RUNTIME_CAPABILITY)
})

it('gives a WSL fish pane the account function, and leaves other WSL commands alone', () => {
  const pane = buildWslInteractiveLoginShellCommand()
  expect(pane).toContain('"$_orca_wsl_shell" -l -C')
  expect(getFishClaudeShellFunction()).toContain('ORCA_CLAUDE_PROFILE_POINTER')
  expect(buildWslLoginShellCommand('true')).not.toContain('fish')
})
