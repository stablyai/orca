import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function componentSource(file: string): string {
  return readFileSync(join(__dirname, file), 'utf8')
}

describe('Linear issue workspace provider API parity', () => {
  it('keeps detail and comments on the selected source and workspace', () => {
    const source = componentSource('linear-issue-workspace-detail-state.ts')
    expect(source).toContain('initialRequest.providerSettings,')
    expect(source).toContain('initialRequest.issue.id,')
    expect(source).toContain('initialRequest.issue.workspaceId')
    expect(source).toContain('targetProviderSettings,')
    expect(source).toContain('targetIssue.id,')
    expect(source).toContain('targetIssue.workspaceId')
  })

  it('keeps project search and assignment source-scoped', () => {
    const source = componentSource('linear-issue-project-selector.tsx')
    expect(source).toContain(
      'linearListProjects(providerSettings, requestQuery, 20, issue.workspaceId)'
    )
    expect(source).toMatch(
      /linearUpdateIssue\(\s*providerSettings,\s*issue\.id,\s*\{ projectId: project\.id \},\s*issue\.workspaceId/
    )
    expect(source).toContain('patchLinearIssue(issue.id, { project }, { sourceContext })')
  })

  it('keeps sub-issue create and open payloads source-scoped', () => {
    const source = componentSource('linear-issue-sub-issues.tsx')
    expect(source).toContain('parentIssueId: issue.id')
    expect(source).toContain('teamId: issue.team.id')
    expect(source).toContain('workspaceId: issue.workspaceId')
    expect(source).toContain('projectId: issue.project?.id ?? null')
    expect(source).toMatch(
      /fetchLinearIssue\(subIssue\.id, issue\.workspaceId, \{\s*sourceContext\s*\}\)/
    )
  })

  it('keeps git and folder workspace attachments in the same lookup', () => {
    const source = componentSource('LinearIssueWorkspace.tsx')
    expect(source).toContain('...allWorktrees')
    expect(source).toContain('...folderWorkspaces.map(folderWorkspaceToWorktree)')
    expect(source).toContain('findLinearIssueWorkspaceAttachment(attachmentWorkspaces')
    expect(source).toContain('openLinearIssueWorkspaceOrStart(detail.displayed')
  })
})
