import { describe, expect, it } from 'vitest'
import { dshHomeFromSessionPath } from './dsh-session-paths'
import { buildAiVaultResumeCommand } from './ai-vault-resume-command'

describe('DSH exact history resume', () => {
  it.each(['posix', 'cmd', 'powershell'] as const)(
    'uses selected host home and exact id in %s',
    (shell) => {
      const windows = shell === 'cmd' || shell === 'powershell'
      const home = windows ? 'C:\\Users\\Example\\custom dsh' : '/host/custom dsh'
      const path = windows
        ? `${home}\\sessions\\project\\session-id\\session.v4.jsonl.zstd`
        : `${home}/sessions/project/session-id/session.v4.jsonl.zstd`
      expect(dshHomeFromSessionPath(path)).toBe(home)
      const command = buildAiVaultResumeCommand({
        agent: 'dsh',
        sessionId: 'session-id',
        cwd: windows ? 'C:\\project' : '/plain folder',
        resumeFilePath: path,
        platform: windows ? 'win32' : 'linux',
        shell
      })
      expect(command).toContain('DSH_HOME=')
      expect(command).toContain('dsh-tui --resume')
      expect(command).toContain('session-id')
      expect(command).not.toContain('CODEX_HOME')
    }
  )
  it('does not infer a home from a noncanonical or unrelated artifact', () => {
    expect(dshHomeFromSessionPath('/host/arbitrary/session.v4.jsonl')).toBeNull()
  })
})
