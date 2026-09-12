import { beforeEach, describe, expect, it, vi } from 'vitest'
import { duplicateBuiltInAgentAsCustom } from './custom-agent-profile-draft'

describe('custom agent profile drafts', () => {
  beforeEach(() => {
    vi.stubGlobal('crypto', { randomUUID: () => 'profile-id' })
  })

  it('duplicates an effective built-in command into independent literal argv', () => {
    expect(
      duplicateBuiltInAgentAsCustom({
        agent: {
          id: 'codex',
          label: 'Codex',
          cmd: 'codex',
          homepageUrl: 'https://example.com'
        },
        command: 'codex',
        launchArgs: '--model "luna pro"',
        shell: 'posix',
        reservedNames: ['Codex', 'Codex copy']
      })
    ).toEqual({
      id: 'profile-id',
      name: 'Codex copy 2',
      baseAgent: 'codex',
      baseAgentExecutable: 'codex',
      executable: 'codex',
      args: ['--model', 'luna pro']
    })
  })

  it('refuses to reinterpret a shell command override as literal argv', () => {
    expect(
      duplicateBuiltInAgentAsCustom({
        agent: {
          id: 'codex',
          label: 'Codex',
          cmd: 'codex',
          homepageUrl: 'https://example.com'
        },
        command: 'codex && echo unsafe',
        launchArgs: '',
        shell: 'posix',
        reservedNames: []
      })
    ).toBeNull()
  })

  it('preserves Windows drive and UNC paths with the Windows parser', () => {
    expect(
      duplicateBuiltInAgentAsCustom({
        agent: {
          id: 'codex',
          label: 'Codex',
          cmd: 'codex',
          homepageUrl: 'https://example.com'
        },
        command: "'C:\\Program Files\\Codex\\codex.exe'",
        launchArgs: "--config '\\\\server\\share\\codex.toml' C:\\tools\\profile.toml",
        shell: 'powershell',
        reservedNames: []
      })
    ).toEqual(
      expect.objectContaining({
        baseAgentExecutable: 'C:\\Program Files\\Codex\\codex.exe',
        executable: 'C:\\Program Files\\Codex\\codex.exe',
        args: ['--config', '\\\\server\\share\\codex.toml', 'C:\\tools\\profile.toml']
      })
    )
  })
})
