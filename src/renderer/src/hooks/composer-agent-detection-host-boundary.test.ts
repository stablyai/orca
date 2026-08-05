import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync(join(__dirname, 'useComposerState.ts'), 'utf8')

describe('composer agent detection host boundary', () => {
  it('scopes detection to the selected repository execution host', () => {
    // Why: detection is fanned out through setup and issue-command effects;
    // source patterns ensure every dependency keeps the same selected host.
    expect(SOURCE).toContain('projectId: initialTargetSeed?.projectId')
    expect(SOURCE).toContain('hostId: initialTargetSeed?.hostId')
    expect(SOURCE).toContain(
      'selectedProjectHostSetupOverrideId ?? initialTargetSeed?.projectHostSetupId'
    )
    expect(SOURCE).toContain(
      "selectedWorkspaceTarget.status === 'ready' && selectedWorkspaceTarget.target.repoId === repoId"
    )
    expect(SOURCE).toContain('const selectedRepoExecutionHostId = selectedRepo')
    expect(SOURCE).toMatch(
      /const selectedRepoExecutionHost = useMemo\(\s*\(\) => parseExecutionHostId\(selectedRepoExecutionHostId\)/
    )
    expect(SOURCE).toContain('ensureDetectedAgents(repoId ? { repoId } : undefined)')
    expect(SOURCE).toMatch(
      /checkRuntimeHooks\([\s\S]*?targetRepoId,\n\s+selectedRepoExecutionHostId \?\? undefined/
    )
    expect(SOURCE).toContain(
      'const selectedRepoExecutionHostIdRef = useRef(selectedRepoExecutionHostId)\n  useEffect(() => {\n    selectedRepoExecutionHostIdRef.current = selectedRepoExecutionHostId\n  }, [selectedRepoExecutionHostId])'
    )
    expect(SOURCE).toMatch(
      /readRuntimeIssueCommand\(\s*selectedRepoSettingsRef\.current,\s*repoId,\s*selectedRepoExecutionHostId \?\? undefined/
    )
    expect(
      SOURCE.match(
        /'(?:setup|issueCommand|vmRecipe)',\n\s+selectedRepoExecutionHostId \?\? undefined/g
      )
    ).toHaveLength(3)
  })
})
