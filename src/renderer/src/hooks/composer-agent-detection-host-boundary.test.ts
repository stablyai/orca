import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync(join(__dirname, 'useComposerState.ts'), 'utf8')

describe('composer agent detection host boundary', () => {
  it('scopes detection to the selected repository execution host', () => {
    expect(SOURCE).toContain('projectId: initialTargetSeed?.projectId')
    expect(SOURCE).toContain('hostId: initialTargetSeed?.hostId')
    expect(SOURCE).toContain('projectHostSetupId: initialTargetSeed?.projectHostSetupId')
    expect(SOURCE).toContain(
      "selectedWorkspaceTarget.status === 'ready'\n      ? selectedWorkspaceTarget.target.repo"
    )
    expect(SOURCE).toContain('const selectedRepoExecutionHostId = selectedRepo')
    expect(SOURCE).toContain(
      'const selectedRepoExecutionHost = parseExecutionHostId(selectedRepoExecutionHostId)'
    )
    expect(SOURCE).toContain('ensureDetectedAgents(repoId ? { repoId } : undefined)')
    expect(SOURCE).toContain('selectedRepoExecutionHostIdRef.current ?? undefined')
    expect(SOURCE).toContain('readRuntimeIssueCommand(')
    expect(
      SOURCE.match(
        /'(?:setup|issueCommand|vmRecipe)',\n\s+selectedRepoExecutionHostId \?\? undefined/g
      )
    ).toHaveLength(4)
  })
})
