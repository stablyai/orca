import { describe, expect, it } from 'vitest'
import {
  buildAiVaultResumeCopyCommandForWorktree,
  buildAiVaultResumeStartupForWorktree,
  type AiVaultResumeWorktreeArgs
} from './ai-vault-resume-command'

const state: AiVaultResumeWorktreeArgs['state'] = {
  activeRepoId: null,
  activeWorktreeId: null,
  folderWorkspaces: [],
  projectGroups: [],
  projects: [],
  repos: [],
  settings: null,
  worktreesByRepo: {}
}

describe('Hermes history resume on independently updated hosts', () => {
  it.each(['ssh:dev-box', 'runtime:paired-host'] as const)(
    'rebuilds old %s commands from the source profile for copy and terminal launch',
    (executionHostId) => {
      const session = {
        agent: 'hermes' as const,
        sessionId: 'same',
        cwd: '/workspace',
        codexHome: null,
        executionHostId,
        executionHostPlatform: 'linux' as const,
        filePath: '/custom/hermes/profiles/work/state.db#same',
        resumeCommand: "hermes --resume 'same'"
      }
      const command = buildAiVaultResumeStartupForWorktree({ state, session }).command
      expect(command).toContain('HERMES_HOME=/custom/hermes')
      expect(command).toContain("--profile 'work'")
      expect(buildAiVaultResumeCopyCommandForWorktree({ state, session })).toContain(
        "--profile 'work'"
      )
    }
  )
  it('uses the recorded remote Windows grammar for an older unscoped command', () => {
    const session = {
      agent: 'hermes' as const,
      sessionId: 'same',
      cwd: null,
      codexHome: null,
      executionHostId: 'ssh:win-box' as const,
      executionHostPlatform: 'win32' as const,
      filePath: 'C:\\Users\\Ada\\AppData\\Local\\hermes\\state.db#same',
      resumeCommand: 'hermes --resume same'
    }
    const command = buildAiVaultResumeStartupForWorktree({ state, session }).command
    expect(command).toContain("$env:HERMES_HOME='C:\\Users\\Ada\\AppData\\Local\\hermes'")
    expect(command).toContain("--profile 'default'")
  })
})
