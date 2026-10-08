import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runProcess } from './child-process/run-process'
import { quotePosixShell } from './wsl-login-shell-command'
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
    'plink.exe -i key',
    'ssh -i key | record-access',
    'ssh -i key > log',
    'ssh -i "unterminated',
    'ssh -o "ProxyCommand=proxy `date`"',
    'ssh\\ -i key'
  ])('preserves shell and wrapper semantics (%s)', (command) => {
    expect(buildGitSshPolicyEnv({}, command).env.GIT_SSH_COMMAND).toBeUndefined()
  })

  it('preserves quoted identity arguments while enforcing OpenSSH batch mode', () => {
    expect(
      buildGitSshPolicyEnv(
        {},
        '"C:/Program Files/Git/usr/bin/ssh.exe" -i "C:/Users/test/key file" -oBatchMode=no'
      ).env.GIT_SSH_COMMAND
    ).toBe(
      '"C:/Program Files/Git/usr/bin/ssh.exe" -o BatchMode=yes -i "C:/Users/test/key file" -oBatchMode=no'
    )
  })

  it('preserves a bare UNC executable path', () => {
    const executable = String.raw`\\server\share\ssh.exe`
    expect(buildGitSshPolicyEnv({}, `${executable} -i key`).env.GIT_SSH_COMMAND).toBe(
      `${quotePosixShell(executable)} -o BatchMode=yes -i key`
    )
  })
})

describe.skipIf(process.platform === 'win32')('SSH policy with a real POSIX shell', () => {
  it.each([
    [String.raw` -i C:\keys\work`, ['-i', String.raw`C:\keys\work`]],
    [String.raw` -i C:\keys\work\&key`, ['-i', String.raw`C:\keys\work&key`]],
    [String.raw` -i C:\keys\work\;key`, ['-i', String.raw`C:\keys\work;key`]],
    [String.raw` -i C:\keys\work\|key`, ['-i', String.raw`C:\keys\work|key`]],
    [String.raw` -i C:\keys\work\<key`, ['-i', String.raw`C:\keys\work<key`]],
    [String.raw` -i C:\keys\work\>key`, ['-i', String.raw`C:\keys\work>key`]],
    [String.raw` -i C:\keys\work\(key`, ['-i', String.raw`C:\keys\work(key`]],
    [String.raw` -i C:\keys\work\)key`, ['-i', String.raw`C:\keys\work)key`]],
    [' -i C:\\keys\\work\\`key', ['-i', 'C:\\keys\\work`key']],
    [String.raw` -iC:\keys\work`, [String.raw`-iC:\keys\work`]],
    [String.raw` -i \\server\share\work`, ['-i', String.raw`\\server\share\work`]],
    [String.raw` -i \\\\server\share\work`, ['-i', String.raw`\\server\share\work`]],
    [String.raw` -i\\server\share\work`, [String.raw`-i\\server\share\work`]],
    [
      String.raw` -oIdentityFile=\\server\share\work`,
      [String.raw`-oIdentityFile=\\server\share\work`]
    ],
    [
      String.raw` -o IdentityFile=\\server\share\work`,
      ['-o', String.raw`IdentityFile=\\server\share\work`]
    ],
    [String.raw` -FC:\ssh\config`, [String.raw`-FC:\ssh\config`]],
    [String.raw` -oIdentityFile=C:\keys\work`, [String.raw`-oIdentityFile=C:\keys\work`]],
    [String.raw` -o IdentityFile=C:\keys\work`, ['-o', String.raw`IdentityFile=C:\keys\work`]],
    [String.raw` -o "IdentityFile=C:\keys\work"`, ['-o', String.raw`IdentityFile=C:\keys\work`]],
    [
      String.raw` -o 'ProxyCommand=C:\bin\proxy %h'`,
      ['-o', String.raw`ProxyCommand=C:\bin\proxy %h`]
    ]
  ])('retains unquoted Windows option paths: %s', async (suffix, expected) => {
    const command = buildGitSshPolicyEnv({}, `ssh${suffix}`).env.GIT_SSH_COMMAND
    if (!command) {
      throw new Error('Missing SSH command')
    }
    const result = await runProcess({
      program: '/bin/sh',
      args: ['-c', `ssh() { printf '%s\\0' "$@"; }; ${command}`]
    })
    expect(result.code).toBe(0)
    expect(result.stdout.split('\0').slice(0, -1)).toEqual(['-o', 'BatchMode=yes', ...expected])
  })

  it('keeps the enforced first value even when a later option disables BatchMode', async ({
    skip
  }) => {
    const result = await runProcess({
      program: 'ssh',
      args: [
        '-G',
        '-F',
        '/dev/null',
        '-o',
        'BatchMode=yes',
        '-o',
        'BatchMode=no',
        'example.invalid'
      ]
    }).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        skip('OpenSSH is not installed')
      }
      throw error
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/^batchmode yes$/m)
  })

  it.each([
    String.raw` -i 'C:\keys\work\\ key' -o 'ProxyCommand=proxy -i C:\keys\proxy\\ key %h' -oBatchMode=no`,
    String.raw` -i "C:\keys\work\\ key" -o "ProxyCommand=proxy \"C:\keys\proxy\\ key\" %h" -o "BatchMode no"`,
    String.raw` -i 'key (work); and literal & operators' -o 'ProxyCommand=proxy (work) <input> | other'`
  ])('preserves shell-produced arguments: %s', async (suffix) => {
    const root = await mkdtemp(path.join(tmpdir(), 'orca-ssh-policy-'))
    try {
      const directory = path.join(root, 'Program Files (x86)')
      await mkdir(directory)
      const ssh = path.join(directory, 'ssh')
      await writeFile(ssh, '#!/bin/sh\nprintf \'%s\\0\' "$@"\n')
      await chmod(ssh, 0o700)
      const command = `${quotePosixShell(ssh)}${suffix}`
      const policy = buildGitSshPolicyEnv({}, command)
      expect(policy.mode).toBe('configured-openssh')
      const enforced = policy.env.GIT_SSH_COMMAND
      if (!enforced) {
        throw new Error('Missing SSH command')
      }
      expect(enforced).toBe(`${quotePosixShell(ssh)} -o BatchMode=yes${suffix}`)
      const argv = async (shellCommand: string) => {
        const result = await runProcess({
          program: '/bin/sh',
          args: [
            '-c',
            `${shellCommand} "$@"`,
            shellCommand,
            'example.invalid',
            'git-upload-pack repo'
          ]
        })
        expect(result.code).toBe(0)
        return result.stdout.split('\0').slice(0, -1)
      }
      const original = await argv(command)
      const rewritten = await argv(enforced)
      expect(rewritten.slice(0, 2)).toEqual(['-o', 'BatchMode=yes'])
      expect(rewritten.slice(2)).toEqual(original)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
