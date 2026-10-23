import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, describe, expect, it } from 'vitest'
import { buildAiVaultResumeCommand } from './ai-vault-resume-command'
import { buildAiVaultLocalResumeStartup } from './ai-vault-resume-startup'
import { hermesSessionSourceFromFilePath } from './hermes-session-source'
import { quoteStartupArg } from './tui-agent-startup-shell'

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('Hermes session source resume', () => {
  it.each([
    ['/custom/home/state.db#session', 'linux', '/custom/home', '/custom/home', 'default'],
    [
      '/custom/profiles\\work/state.db#session',
      'linux',
      '/custom/profiles\\work',
      '/custom/profiles\\work',
      'default'
    ],
    [
      '/custom/#home/profiles/work/state.db#session',
      'linux',
      '/custom/#home/profiles/work',
      '/custom/#home',
      'work'
    ],
    [
      '/custom/home/profiles/work/sessions/session_1.json',
      'darwin',
      '/custom/home/profiles/work',
      '/custom/home',
      'work'
    ],
    [
      '/custom/home/profiles/work/sessions/session_1.JSON',
      'darwin',
      '/custom/home/profiles/work',
      '/custom/home',
      'work'
    ],
    [
      'C:\\Users\\Ada\\hermes\\state.db#session',
      'win32',
      'C:\\Users\\Ada\\hermes',
      'C:\\Users\\Ada\\hermes',
      'default'
    ],
    ['C:\\state.db#session', 'win32', 'C:\\', 'C:\\', 'default'],
    [
      '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.hermes\\profiles\\work\\state.db#session',
      'linux',
      '/home/ada/.hermes/profiles/work',
      '/home/ada/.hermes',
      'work'
    ]
  ] as const)('retains the store from %s', (filePath, platform, homeDir, rootDir, profileName) => {
    expect(hermesSessionSourceFromFilePath(filePath, platform)).toEqual({
      homeDir,
      rootDir,
      profileName
    })
  })

  it.each([
    undefined,
    '/tmp/hermes-sessions/session_1.json',
    'relative/state.db#session',
    '/custom/home/state.db',
    '/custom/home/profiles/work/sessions/SESSION_1.json',
    '/custom/home/profiles/.deleted/state.db#session'
  ])('keeps unknown or old source paths compatible: %s', (filePath) => {
    expect(hermesSessionSourceFromFilePath(filePath)).toBeNull()
    expect(
      buildAiVaultResumeCommand({
        agent: 'hermes',
        sessionId: 'session',
        cwd: null,
        platform: 'linux',
        resumeFilePath: filePath
      })
    ).toBe("hermes --resume 'session'")
  })

  it.runIf(process.platform !== 'win32')(
    'delivers the source root and one profile selector through a real shell, including local reconstruction',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'orca-hermes-resume-'))
      temporaryRoots.push(root)
      const sourceRoot = path.join(root, "custom #store's & home")
      await mkdir(path.join(sourceRoot, 'profiles', 'work'), { recursive: true })
      await writeFile(path.join(sourceRoot, 'active_profile'), 'work')
      const executable = path.join(root, 'hermes')
      await writeFile(
        executable,
        `#!${process.execPath}\nconsole.log(JSON.stringify({env:process.env.HERMES_HOME,args:process.argv.slice(2),cwd:process.cwd()}))\n`,
        { mode: 0o700 }
      )
      for (const profile of ['default', 'work']) {
        const homeDir =
          profile === 'default' ? sourceRoot : path.join(sourceRoot, 'profiles', profile)
        for (const filePath of [
          `${path.join(homeDir, 'state.db')}#same-id`,
          path.join(homeDir, 'sessions', 'session_same-id.json')
        ]) {
          const startup = buildAiVaultLocalResumeStartup({
            session: {
              agent: 'hermes',
              sessionId: 'same-id',
              cwd: root,
              codexHome: null,
              filePath,
              resumeCommand: 'hermes --resume wrong-id'
            },
            host: { platform: 'linux', codexHome: null, liveShell: 'posix' },
            settings: null,
            commandOverride: `HERMES_HOME=/wrong ${quoteStartupArg(executable, 'posix')} --profile stale --profile=other --resume wrong-id --provider local --tui`,
            embedCwd: true
          })
          const result = await runProcess({
            program: '/bin/sh',
            args: ['-c', startup.command],
            env: { ...process.env, HERMES_HOME: '/inherited-wrong' },
            timeoutMs: 5000
          })
          expect(result.code, result.stderr).toBe(0)
          expect(JSON.parse(result.stdout)).toEqual({
            env: sourceRoot,
            args: ['--profile', profile, '--provider', 'local', '--tui', '--resume', 'same-id'],
            cwd: await realpath(root)
          })
        }
      }
    }
  )

  it.each([
    'uv run hermes --profile stale --tui',
    'uv run hermes --native --profile stale --no-restore-cwd',
    'uv run hermes -c --profile stale',
    'uv run hermes --continue --profile stale',
    'sudo -u hermes hermes -p stale --tui',
    'env HERMES_HOME=/other hermes --profile=stale --tui'
  ])('preserves a wrapper and overrides its store: %s', (commandOverride) => {
    const command = buildAiVaultResumeCommand({
      agent: 'hermes',
      sessionId: 'same-id',
      cwd: null,
      platform: 'linux',
      resumeFilePath: '/custom/profiles/work/state.db#same-id',
      commandOverride
    })
    expect(command).toContain("env 'HERMES_HOME=/custom' hermes --profile 'work'")
    expect(command).not.toContain('stale')
    expect(command).toContain("--resume 'same-id'")
    expect(
      command.startsWith(
        commandOverride.startsWith('sudo')
          ? 'sudo -u hermes '
          : commandOverride.startsWith('uv')
            ? 'uv run '
            : 'env HERMES_HOME=/other '
      )
    ).toBe(true)
  })

  it('quotes the native Windows store for cmd and PowerShell', () => {
    const args = {
      agent: 'hermes',
      sessionId: 'same-id',
      cwd: null,
      platform: 'win32',
      resumeFilePath: "C:\\Users\\Ada's & ^Home\\hermes\\profiles\\work\\state.db#same-id"
    } as const
    expect(
      buildAiVaultResumeCommand({
        ...args,
        shell: 'cmd',
        commandOverride: '"C:\\Program Files\\Hermes\\hermes.exe" --profile stale'
      })
    ).toBe(
      'set "HERMES_HOME=C:\\Users\\Ada\'s & ^Home\\hermes" && "C:\\Program Files\\Hermes\\hermes.exe" --profile "work"   --resume "same-id"'
    )
    expect(
      buildAiVaultResumeCommand({
        ...args,
        shell: 'powershell',
        commandOverride: '& "C:\\Program Files\\Hermes\\hermes.exe" --profile=stale'
      })
    ).toBe(
      "$env:HERMES_HOME='C:\\Users\\Ada''s & ^Home\\hermes'; & \"C:\\Program Files\\Hermes\\hermes.exe\" --profile 'work'  --resume 'same-id'"
    )
  })

  it('preserves a PowerShell call operator separated by a tab', () => {
    const command = buildAiVaultResumeCommand({
      agent: 'hermes',
      sessionId: 'same-id',
      cwd: null,
      platform: 'win32',
      shell: 'powershell',
      resumeFilePath: 'C:\\custom\\state.db#same-id',
      commandOverride: '&\t"C:\\Program Files\\Hermes\\hermes.exe" --tui'
    })
    expect(command).toBe(
      "$env:HERMES_HOME='C:\\custom'; &\t\"C:\\Program Files\\Hermes\\hermes.exe\" --profile 'default' --tui --resume 'same-id'"
    )
  })

  it.each([
    'custom-agent --tui',
    'hermes --profile work && echo wrong',
    'hermes\n--profile wrong',
    'hermes profile delete work',
    'hermes -- --profile wrong',
    "sh -c 'hermes --tui'"
  ])('refuses an ambiguous source-aware override: %s', (commandOverride) => {
    expect(() =>
      buildAiVaultResumeCommand({
        agent: 'hermes',
        sessionId: 'same-id',
        cwd: null,
        platform: 'linux',
        resumeFilePath: '/custom/state.db#same-id',
        commandOverride
      })
    ).toThrow('Cannot safely select this Hermes session store')
  })

  it('refuses source roots that the CLI or cmd would expand into a different directory', () => {
    for (const root of ['/custom/$HOME', 'C:\\Users\\%USERNAME%', 'C:\\Users\\!name!']) {
      expect(() =>
        buildAiVaultResumeCommand({
          agent: 'hermes',
          sessionId: 'same-id',
          cwd: null,
          platform: root.startsWith('/') ? 'linux' : 'win32',
          shell: root.startsWith('/') ? 'posix' : 'cmd',
          resumeFilePath: `${root}/state.db#same-id`
        })
      ).toThrow('Cannot safely select this Hermes session store')
    }
  })

  it.each(['env HERMES_HOME=/other hermes', 'sudo hermes'])(
    'refuses non-POSIX wrappers that can override the source home: %s',
    (commandOverride) => {
      expect(() =>
        buildAiVaultResumeCommand({
          agent: 'hermes',
          sessionId: 'same-id',
          cwd: null,
          platform: 'darwin',
          shell: 'powershell',
          resumeFilePath: '/custom/state.db#same-id',
          commandOverride
        })
      ).toThrow('Cannot safely select this Hermes session store')
    }
  )
})
