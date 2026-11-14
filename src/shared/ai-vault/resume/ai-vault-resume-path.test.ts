import { describe, expect, it } from 'vitest'
import { normalizeAiVaultResumeFilePath } from './ai-vault-resume-path'
import { buildAiVaultLocalResumeStartup } from './ai-vault-resume-startup'

describe('normalizeAiVaultResumeFilePath', () => {
  it('translates a Windows drive store path for a Linux resume target', () => {
    // #42369: WSL reaches the symlinked C:\ store through drvfs.
    expect(
      normalizeAiVaultResumeFilePath('C:\\Users\\ada\\.omp\\agent\\sessions\\s-1.jsonl', 'linux')
    ).toBe('/mnt/c/Users/ada/.omp/agent/sessions/s-1.jsonl')
  })

  it('keeps the drive path for a Windows resume target', () => {
    expect(
      normalizeAiVaultResumeFilePath('C:\\Users\\ada\\.omp\\agent\\sessions\\s-1.jsonl', 'win32')
    ).toBe('C:\\Users\\ada\\.omp\\agent\\sessions\\s-1.jsonl')
  })

  it('translates a UNC store path to the distro tail and leaves POSIX paths alone', () => {
    expect(
      normalizeAiVaultResumeFilePath(
        '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.omp\\agent\\sessions\\s-1.jsonl',
        'linux'
      )
    ).toBe('/home/ada/.omp/agent/sessions/s-1.jsonl')
    expect(normalizeAiVaultResumeFilePath('/home/ada/.omp/agent/sessions/s-1.jsonl', 'linux')).toBe(
      '/home/ada/.omp/agent/sessions/s-1.jsonl'
    )
  })

  it('builds a WSL resume command whose --resume path runs inside the distro', () => {
    // The cd part was already native; before #42369 the store path stayed C:\ and omp rejected it.
    const startup = buildAiVaultLocalResumeStartup({
      session: {
        agent: 'omp',
        sessionId: 's-1',
        cwd: '/home/ada/inbox',
        codexHome: null,
        filePath: 'C:\\Users\\ada\\.omp\\agent\\sessions\\-inbox\\s-1.jsonl'
      },
      host: { platform: 'linux', codexHome: null, liveShell: undefined },
      settings: null,
      embedCwd: true
    })
    expect(startup.command).toBe(
      "cd '/home/ada/inbox' && omp --resume '/mnt/c/Users/ada/.omp/agent/sessions/-inbox/s-1.jsonl'"
    )
  })
})
