import { describe, expect, it } from 'vitest'
import { reportedWorkspacePrLines, workspacePrCopy } from './workspace-pr-copy'

const payload = (outside: unknown[]) =>
  JSON.stringify({ workspaceCheck: { version: 1, state: 'complete', outside } })

describe('off-workspace pull request copy', () => {
  it('names only reader-supplied values with reader placeholders', () => {
    const texts = [
      workspacePrCopy.preamble('orca', 'feature', '/w/feature', 'p::/w/feature'),
      workspacePrCopy.worker('org/q', 17, 'orca', 'p::/w/feature'),
      workspacePrCopy.parent_required()
    ]
    for (const text of texts) {
      expect(text).not.toContain('"<path>"')
      expect(text).not.toContain('<workspace id>')
    }
    expect(texts[0]).toContain('--path "<your-worktree-path>"')
    expect(texts[1]).toContain('--path "<your-worktree-path>"')
    expect(texts[2]).toBe('Choose a parent with --parent-worktree "id:<parent-workspace-id>".')
  })

  it('says "another" project only for a git workspace', () => {
    expect(workspacePrCopy.preamble('orca', 'feature', '/w/feature', 'p::/w/feature')).toBe(
      `=== YOUR WORKSPACE ===
Your Orca workspace is feature, at /w/feature.
For changes and pull requests in another registered project, create a workspace:
  orca worktree create --repo <project> --name <short-name> --parent-worktree 'id:p::/w/feature'
Use orca repo list to find projects. If a project is missing or inaccessible, ask your coordinator.
If you already made a git worktree, adopt it before reporting completion:
  orca worktree adopt --path "<your-worktree-path>" --parent-worktree 'id:p::/w/feature'
Read-only and test scratch copies are fine anywhere, but don't push from them or open PRs from them.`
    )
    expect(workspacePrCopy.preamble('orca', 'home', '/w/home', 'folder:home')).toContain(
      'For changes and pull requests in a registered project, create a workspace:'
    )
  })

  it('tells a finished worker to take no action, with the full command its coordinator may run', () => {
    expect(workspacePrCopy.worker('git.example/org/q', 17, 'orca', 'p::/w/feature')).toBe(
      'At report time, Orca found no workspace for git.example/org/q under your workspace (cited: #17). If you opened it, take no action now; your coordinator may resume you to run: orca worktree adopt --path "<your-worktree-path>" --parent-worktree \'id:p::/w/feature\''
    )
  })

  it('hedges the coordinator line the same way and points to the receipt command', () => {
    expect(
      reportedWorkspacePrLines(
        payload([
          { forgeHost: 'github.com', owner: 'org', repo: 'q', number: 17 },
          { forgeHost: 'git.example', owner: 'org', repo: 'e', number: 3 }
        ])
      )
    ).toEqual([
      'Orca: At report time, Orca found no workspace for org/q under this worker (cited: #17). If the worker opened it, resume the worker to run the orca worktree adopt command (with --path and --parent-worktree) from its completion receipt.',
      'Orca: At report time, Orca found no workspace for git.example/org/e under this worker (cited: #3). If the worker opened it, resume the worker to run the orca worktree adopt command (with --path and --parent-worktree) from its completion receipt.'
    ])
  })

  it('gives the retry and lookup guidance from review', () => {
    expect(workspacePrCopy.adopt_failed('/w/q')).toBe(
      'Orca could not finish adopting /w/q. Retry once; if it fails again, ask your coordinator.'
    )
    expect(workspacePrCopy.parent_unavailable()).toBe(
      'Orca could not find the worktree and the parent workspace together on this host. Check the --path and --parent-worktree values.'
    )
  })
})
