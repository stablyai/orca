import { describe, expect, it } from 'vitest'
import { attachFingerprintFields } from '../../../../main/native-chat/agent-session-wire/acquisition/structured-agent-session-attach'
import {
  extractAdditionalDirectoriesFromArgs,
  isAgentSessionAdditionalDirectories,
  resolveAdditionalDirectoriesFromLaunch
} from './agent-session-additional-directories'

describe('agent-session-additional-directories', () => {
  it('preserves Windows backslash paths under powershell tokenization', () => {
    expect(
      extractAdditionalDirectoriesFromArgs(
        '--model gemini --add-dir C:\\Users\\PC\\repo -add-dir=D:\\shared',
        'powershell'
      )
    ).toEqual(['C:\\Users\\PC\\repo', 'D:\\shared'])
  })

  it('stops extracting after -- and deduplicates across sources', () => {
    expect(
      extractAdditionalDirectoriesFromArgs(
        '--add-dir "/tmp/a b" -- --add-dir /tmp/ignored',
        'posix'
      )
    ).toEqual(['/tmp/a b'])

    expect(
      resolveAdditionalDirectoriesFromLaunch(
        ['/repo/one', '/repo/two'],
        '--add-dir /repo/two --add-dir /repo/three',
        undefined,
        'posix'
      )
    ).toEqual(['/repo/one', '/repo/two', '/repo/three'])
  })

  it('resolves relative default directories against cwd for POSIX and Windows hosts', () => {
    expect(
      resolveAdditionalDirectoriesFromLaunch(
        ['/repo/abs'],
        '--add-dir ../materials --add-dir ./docs',
        '/workspace/project',
        'posix'
      )
    ).toEqual(['/repo/abs', '/workspace/materials', '/workspace/project/docs'])

    expect(
      resolveAdditionalDirectoriesFromLaunch(
        undefined,
        '--add-dir ..\\shared',
        'C:\\Users\\PC\\repo',
        'powershell'
      )
    ).toEqual(['C:\\Users\\PC\\shared'])

    expect(
      resolveAdditionalDirectoriesFromLaunch(
        ['\\materials', 'C:docs'],
        undefined,
        'C:\\workspace\\project',
        'powershell'
      )
    ).toEqual(['C:\\materials', 'C:\\workspace\\project\\docs'])

    expect(() =>
      resolveAdditionalDirectoriesFromLaunch(
        ['D:other'],
        undefined,
        'C:\\workspace\\project',
        'powershell'
      )
    ).toThrow(/drive-relative/)
  })

  it('enforces the 64-entry cap across merged directories', () => {
    const sixtyFour = Array.from({ length: 64 }, (_, index) => `/dir/${index}`)
    expect(
      resolveAdditionalDirectoriesFromLaunch(sixtyFour, '--add-dir /dir/0', '/repo', 'posix')
    ).toHaveLength(64)
    expect(() =>
      resolveAdditionalDirectoriesFromLaunch(sixtyFour, '--add-dir /dir/64', '/repo', 'posix')
    ).toThrow(/maximum allowed is 64/)
  })

  it('includes non-empty additionalDirectories in attachFingerprintFields', () => {
    const base: Parameters<typeof attachFingerprintFields>[0] = {
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'ws_1',
        workspaceKind: 'git-worktree'
      },
      provider: 'antigravity',
      agent: 'antigravity',
      accountHome: { variable: 'HOME', path: '/home/u' },
      runtimeKind: 'native',
      envelope: {
        sessionId: 'sess_1234',
        clientOperationId: 'op_1',
        expectedRuntimeFence: null,
        payloadFingerprint: 'fp'
      }
    }

    expect(
      attachFingerprintFields({ ...base, additionalDirectories: [] }).additionalDirectories
    ).toBeUndefined()
    expect(
      attachFingerprintFields({ ...base, additionalDirectories: ['/extra/a'] })
        .additionalDirectories
    ).toEqual(['/extra/a'])
  })

  it('validates persisted additionalDirectories bounds and rejects NUL bytes', () => {
    expect(isAgentSessionAdditionalDirectories(['/repo/a', '/repo/b'])).toBe(true)
    expect(isAgentSessionAdditionalDirectories([''])).toBe(false)
    expect(isAgentSessionAdditionalDirectories(['/repo/a\0b'])).toBe(false)
    expect(isAgentSessionAdditionalDirectories(Array(65).fill('/repo'))).toBe(false)
    expect(isAgentSessionAdditionalDirectories(['x'.repeat(4097)])).toBe(false)
  })
})
