import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'

import ImportedWorktreesVisibilityCard from './ImportedWorktreesVisibilityCard'
import { TooltipProvider } from '@/components/ui/tooltip'

const hiddenWorktrees = [
  {
    id: 'hidden-1',
    displayName: 'payments-refactor',
    path: '/worktrees/demo-project/payments-refactor',
    branch: 'refs/heads/payments-refactor'
  },
  {
    id: 'hidden-2',
    displayName: 'auth-cache-debug',
    path: '/worktrees/demo-project/auth-cache-debug',
    branch: 'refs/heads/auth-cache-debug'
  },
  {
    id: 'hidden-3',
    displayName: 'legacy-oauth-fix',
    path: '/worktrees/legacy/legacy-oauth-fix',
    branch: 'refs/heads/legacy-oauth-fix'
  },
  {
    id: 'hidden-4',
    displayName: 'ssh-worktree',
    path: '/srv/repos/orca/ssh-worktree',
    branch: 'refs/heads/ssh-worktree'
  }
]

function renderCard(
  overrides: Partial<ComponentProps<typeof ImportedWorktreesVisibilityCard>> = {}
): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <ImportedWorktreesVisibilityCard
        repoDisplayName="orca"
        hiddenWorktrees={hiddenWorktrees}
        placement="repo-group"
        pending={false}
        error={null}
        onShow={vi.fn()}
        onKeepHidden={vi.fn()}
        {...overrides}
      />
    </TooltipProvider>
  )
}

describe('ImportedWorktreesVisibilityCard', () => {
  it('renders the required repo-group copy, three-item preview, actions, and repo menu hint', () => {
    const markup = renderCard()

    expect(markup).toContain('Imported 4 existing worktrees')
    expect(markup).toContain(
      'Orca found 4 worktrees and imported them automatically into this repo.'
    )
    expect(markup).toContain('payments-refactor')
    expect(markup).toContain('auth-cache-debug')
    expect(markup).toContain('legacy-oauth-fix')
    expect(markup).toContain('/worktrees/demo-project')
    expect(markup).toContain('/worktrees/legacy')
    expect((markup.match(/>hidden</g) ?? []).length).toBe(3)
    expect(markup).toContain('Show 1 more')
    expect(markup).not.toContain('ssh-worktree')
    expect(markup).not.toContain('refs/heads/payments-refactor')
    expect(markup).not.toContain('/worktrees/demo-project/payments-refactor')
    expect(markup).toContain('repo options')
    expect(markup).toContain('Keep hidden')
    expect(markup).toContain('Show')
  })

  it('scopes pinned fallback copy to the repo name', () => {
    const markup = renderCard({ placement: 'pinned-fallback' })

    expect(markup).toContain('Imported 4 existing worktrees in orca')
    expect(markup).toContain('imported them automatically into orca.')
    expect(markup).toContain('Showing them restores the imported worktrees to the repo list.')
    expect(markup).not.toContain('repo options')
  })

  it('preserves Windows parent path separators in the preview', () => {
    const markup = renderCard({
      hiddenWorktrees: [
        {
          id: 'windows-hidden',
          displayName: 'FeatureX',
          path: 'C:\\Repos\\Orca\\FeatureX'
        }
      ]
    })

    expect(markup).toContain('C:\\Repos\\Orca')
    expect(markup).not.toContain('C:/Repos/Orca')
  })

  it('does not expose Keep hidden in the pinned-only fallback state', () => {
    const markup = renderCard({ placement: 'pinned-fallback', onKeepHidden: undefined })

    expect(markup).not.toContain('Keep hidden')
    expect(markup).toContain('Use Show to restore this repo')
    expect(markup).toContain('Show')
  })

  it('disables actions while pending and renders inline errors', () => {
    const markup = renderCard({ pending: true, error: 'Could not show imported worktrees.' })

    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain('disabled=""')
    expect(markup).toContain('role="alert"')
    expect(markup).toContain('Could not show imported worktrees.')
  })
})
