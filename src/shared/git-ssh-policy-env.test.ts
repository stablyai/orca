import { describe, expect, it } from 'vitest'
import { buildGitSshPolicyEnv, parseGitSshConfig } from './git-ssh-policy-env'

describe('Git network SSH policy', () => {
  it('parses the last matching value without dropping embedded newlines', () => {
    expect(
      parseGitSshConfig(
        'core.sshcommand\nssh -i first\0ssh.variant\nsimple\0core.sshcommand\nwrapper\nnext\0'
      )
    ).toEqual({ command: 'wrapper\nnext', variant: 'simple' })
    expect(parseGitSshConfig('')).toEqual({ command: '', variant: undefined })
  })

  it.each([
    { GIT_SSH_COMMAND: 'custom-command -i key' },
    { GIT_SSH: 'custom-wrapper' },
    { GIT_SSH: 'custom-wrapper', GIT_SSH_COMMAND: 'explicit-command' }
  ])('preserves explicit SSH environment (%j)', (env) => {
    expect(buildGitSshPolicyEnv(env, 'ssh -i configured')).toEqual({ env, mode: 'explicit-env' })
  })

  it.each(['simple', 'plink', 'putty', 'tortoiseplink'])(
    'leaves configured %s variants to Git',
    (variant) => {
      expect(buildGitSshPolicyEnv({}, 'ssh -i identity', variant)).toEqual({
        env: {},
        mode: 'configured-wrapper-passthrough'
      })
    }
  )

  it('gives explicit variant environment precedence over config', () => {
    expect(
      buildGitSshPolicyEnv({ GIT_SSH_VARIANT: 'simple' }, 'ssh', 'ssh').env.GIT_SSH_COMMAND
    ).toBeUndefined()
    expect(
      buildGitSshPolicyEnv({ GIT_SSH_VARIANT: 'ssh' }, 'ssh', 'simple').env.GIT_SSH_COMMAND
    ).toBe('ssh -o BatchMode=yes')
  })

  it.each([
    'ssh -i "$HOME/key"',
    'ssh -i ~/identity*',
    "ssh -i '~/identity'",
    'ssh -i key # comment',
    'ssh -i key\nrecord-access',
    'ssh -i key && record-access',
    'wrapper --account work',
    'plink.exe -i key'
  ])('preserves shell and wrapper semantics (%s)', (command) => {
    expect(buildGitSshPolicyEnv({}, command).env.GIT_SSH_COMMAND).toBeUndefined()
  })

  it('preserves quoted identity arguments while enforcing OpenSSH batch mode', () => {
    expect(
      buildGitSshPolicyEnv(
        {},
        '"C:/Program Files/Git/usr/bin/ssh.exe" -i "C:/Users/test/key file" -oBatchMode=no'
      ).env.GIT_SSH_COMMAND
    ).toBe("'C:/Program Files/Git/usr/bin/ssh.exe' -i 'C:/Users/test/key file' -o BatchMode=yes")
  })
})
