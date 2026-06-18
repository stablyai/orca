import { describe, expect, it } from 'vitest'
import { buildResolvePullRequestConflictsPrompt } from './SourceControl'

describe('buildResolvePullRequestConflictsPrompt', () => {
  it('explains how to reproduce pull request conflicts when no local merge exists yet', () => {
    const prompt = buildResolvePullRequestConflictsPrompt({
      worktreePath: '/repo/worktree',
      baseRef: 'main',
      entries: [{ path: 'src/render.ts' }]
    })

    expect(prompt).toContain('Resolve the merge conflicts reported for this pull request')
    expect(prompt).toContain(
      '- Conflict source: pull request mergeability check (the local worktree may not have MERGE_HEAD yet).'
    )
    expect(prompt).toContain('- PR base branch: "main"')
    expect(prompt).toContain('- Operation to create locally: merge')
    expect(prompt).toContain('do not treat the handoff as stale')
    expect(prompt).toContain('git fetch origin main')
    expect(prompt).toContain('git merge --no-ff --no-edit FETCH_HEAD')
    expect(prompt).toContain('- "src/render.ts" (Conflict)')
    expect(prompt).not.toContain('Resolve the current merge conflicts')
  })

  it('does not emit unquoted git commands for option-looking base branches', () => {
    const prompt = buildResolvePullRequestConflictsPrompt({
      worktreePath: '/repo/worktree',
      baseRef: '-upload-pack=sh',
      entries: [{ path: 'src/conflict.ts' }]
    })

    expect(prompt).toContain('- PR base branch: "-upload-pack=sh"')
    expect(prompt).toContain('quoting the ref exactly for the current shell')
    expect(prompt).toContain('after verifying the fetched ref exists')
    expect(prompt).not.toContain('git fetch origin -upload-pack=sh')
    expect(prompt).not.toContain('origin/-upload-pack=sh')
  })

  it('uses merge request wording for GitLab conflict prompts', () => {
    const prompt = buildResolvePullRequestConflictsPrompt({
      reviewKind: 'MR',
      worktreePath: '/repo/worktree',
      baseRef: 'main',
      entries: [{ path: 'src/conflict.ts' }]
    })

    expect(prompt).toContain('reported for this merge request')
    expect(prompt).toContain('- Conflict source: merge request mergeability check')
    expect(prompt).toContain('- MR base branch: "main"')
    expect(prompt).not.toContain('pull request')
  })
})
