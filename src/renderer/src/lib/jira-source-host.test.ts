import { describe, expect, it } from 'vitest'
import { resolveJiraSourceHostId } from './jira-source-host'

describe('resolveJiraSourceHostId', () => {
  it('keeps local and paired-runtime Jira ownership', () => {
    expect(resolveJiraSourceHostId({ workspaceHostId: 'local' })).toBe('local')
    expect(resolveJiraSourceHostId({ workspaceHostId: 'runtime:env-1' })).toBe('runtime:env-1')
  })

  it('routes direct SSH Jira reads through the local provider host', () => {
    expect(resolveJiraSourceHostId({ workspaceHostId: 'ssh:server-1' })).toBe('local')
  })

  it('uses repo-less folder group ownership with SSH falling back to local', () => {
    expect(resolveJiraSourceHostId({ groupExecutionHostId: 'runtime:folder-env' })).toBe(
      'runtime:folder-env'
    )
    expect(resolveJiraSourceHostId({ groupConnectionId: 'ssh-target' })).toBe('local')
    expect(resolveJiraSourceHostId({})).toBe('local')
  })
})
