import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ADD_REPO_DIALOG_PATH = join(dirname(fileURLToPath(import.meta.url)), 'AddRepoDialog.tsx')
const ADD_REPO_FLOW_PATHS = [
  ADD_REPO_DIALOG_PATH,
  join(dirname(fileURLToPath(import.meta.url)), 'AddRepoSteps.tsx'),
  join(dirname(fileURLToPath(import.meta.url)), 'useAddRepoCloneFlow.ts'),
  join(dirname(fileURLToPath(import.meta.url)), 'useAddRepoLocalFolderFlow.ts'),
  join(dirname(fileURLToPath(import.meta.url)), 'useAddRepoServerPathFlow.ts'),
  join(dirname(fileURLToPath(import.meta.url)), 'useAddRepoNestedImportFlow.ts')
]

function readAddRepoFlowSource(): string {
  return ADD_REPO_FLOW_PATHS.map((path) => readFileSync(path, 'utf8')).join('\n')
}

describe('AddRepoDialog default-checkout handoff', () => {
  it('does not retain the removed setup-step routing branch', () => {
    const source = readFileSync(ADD_REPO_DIALOG_PATH, 'utf8')

    expect(source).not.toContain("setStep('setup')")
    expect(source).not.toContain('<SetupStep')
    expect(source).not.toContain('AddRepoSetupStep')
  })

  it('requests authoritative worktree refresh before Git handoff paths complete', () => {
    const source = readAddRepoFlowSource()

    expect(source.match(/requireAuthoritative: true/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
    expect(source).toContain("onGitRepoReady(repo.id, 'clone_url')")
    expect(source).toContain("onGitRepoReady(repo.id, 'runtime_server_path')")
    expect(source).toContain('onGitRepoReady(repo.id, source)')
  })

  it('does not fail nested import completion on non-authoritative refresh', () => {
    const source = readAddRepoFlowSource()

    expect(source).not.toContain('Could not refresh project worktrees. Try again.')
    expect(source).toContain('await fetchWorktrees(projectId, { requireAuthoritative: true })')
    expect(source).toContain('await onGitRepoReady(repo.id, source)')
  })
})
