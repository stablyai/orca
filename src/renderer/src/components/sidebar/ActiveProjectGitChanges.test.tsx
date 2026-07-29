import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { GitStatusEntry } from '../../../../shared/types'
import { countProjectGitChanges, ProjectGitChanges } from './ActiveProjectGitChanges'

function gitEntry(status: GitStatusEntry['status'], path: string): GitStatusEntry {
  return {
    path,
    status,
    area: status === 'untracked' ? 'untracked' : 'unstaged'
  }
}

describe('ActiveProjectGitChanges', () => {
  it('groups Git statuses into modified, deleted, and added counts', () => {
    expect(
      countProjectGitChanges([
        gitEntry('modified', 'modified.ts'),
        gitEntry('renamed', 'renamed.ts'),
        gitEntry('copied', 'copied.ts'),
        gitEntry('deleted', 'deleted.ts'),
        gitEntry('added', 'added.ts'),
        gitEntry('untracked', 'untracked.ts')
      ])
    ).toEqual({ modified: 3, deleted: 1, added: 2 })
  })

  it('renders non-zero counts in modified, deleted, added order', () => {
    const markup = renderToStaticMarkup(
      <ProjectGitChanges
        entries={[
          gitEntry('added', 'added.ts'),
          gitEntry('deleted', 'deleted.ts'),
          gitEntry('modified', 'modified-a.ts'),
          gitEntry('modified', 'modified-b.ts')
        ]}
      />
    )

    expect(markup).toMatch(/data-git-change-kind="modified"[^>]*>!2<\/span>/)
    expect(markup).toMatch(/data-git-change-kind="deleted"[^>]*>!1<\/span>/)
    expect(markup).toMatch(/data-git-change-kind="added"[^>]*>!1<\/span>/)
    expect(markup).toContain('text-[var(--git-decoration-modified)]')
    expect(markup).toContain('text-[var(--git-decoration-deleted)]')
    expect(markup).toContain('text-[var(--git-decoration-added)]')
    expect(markup.indexOf('modified')).toBeLessThan(markup.indexOf('deleted'))
    expect(markup.indexOf('deleted')).toBeLessThan(markup.indexOf('added'))
  })

  it('renders nothing for a clean or not-yet-loaded worktree', () => {
    expect(renderToStaticMarkup(<ProjectGitChanges entries={[]} />)).toBe('')
    expect(renderToStaticMarkup(<ProjectGitChanges entries={undefined} />)).toBe('')
  })
})
