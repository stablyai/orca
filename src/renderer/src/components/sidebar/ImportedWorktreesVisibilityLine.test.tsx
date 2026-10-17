import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import ImportedWorktreesVisibilityLine, {
  groupWorktreesByParentPath
} from './ImportedWorktreesVisibilityLine'
import { TooltipProvider } from '@/components/ui/tooltip'
import { i18n } from '@/i18n/i18n'

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

function renderLine(
  overrides: Partial<ComponentProps<typeof ImportedWorktreesVisibilityLine>> = {}
): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <ImportedWorktreesVisibilityLine
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

describe('ImportedWorktreesVisibilityLine', () => {
  it('renders the compact repo-group line with expand and dismiss actions', () => {
    const markup = renderLine()

    expect(markup).toContain('Hiding 4 discovered worktrees')
    expect(markup).toContain('Expand hidden worktrees for orca')
    expect(markup).toContain(
      'Keep 4 discovered worktrees hidden for orca; recover from the project menu'
    )
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).not.toContain('Imported 4 existing worktrees')
    expect(markup).not.toContain('Orca found 4 worktrees')
    expect(markup).not.toContain('repo options')
    expect(markup).not.toContain('Reveal')
    expect(markup).not.toContain('Always show')
    expect(markup).not.toContain('Hidden worktrees by location')
    expect(markup).not.toContain('payments-refactor')
    expect(markup).not.toContain('/worktrees/demo-project')
  })

  it('names the host when the project is checked out on more than one', () => {
    const markup = renderLine({ hostContextLabel: 'openclaw' })

    expect(markup).toContain('openclaw')
    expect(markup).toContain('Expand hidden worktrees for orca on openclaw')
    expect(markup).toContain(
      'Keep 4 discovered worktrees hidden for orca on openclaw; recover from the project menu'
    )
  })

  it('folds the host into pinned fallback copy, which already names the repo', () => {
    const markup = renderLine({
      hostContextLabel: 'openclaw',
      placement: 'pinned-fallback',
      onKeepHidden: undefined
    })

    expect(markup).toContain('Hiding 4 discovered worktrees in orca on openclaw')
  })

  it('uses the singular noun for one hidden worktree', () => {
    const markup = renderLine({ hiddenWorktrees: hiddenWorktrees.slice(0, 1) })

    expect(markup).toContain('Hiding 1 discovered worktree<')
    expect(markup).toContain(
      'Keep 1 discovered worktree hidden for orca; recover from the project menu'
    )
  })

  it('scopes pinned fallback copy to the repo name without a dismiss action', () => {
    const markup = renderLine({ placement: 'pinned-fallback', onKeepHidden: undefined })

    expect(markup).toContain('Hiding 4 discovered worktrees in orca')
    expect(markup).not.toContain('Review')
    expect(markup).not.toContain('Keep hidden - recover from the project menu')
  })

  it('normalizes Windows parent path separators in preview groups', () => {
    const groups = groupWorktreesByParentPath([
      {
        id: 'windows-hidden',
        displayName: 'FeatureX',
        path: 'C:\\Repos\\Orca\\FeatureX'
      }
    ])

    expect(groups).toMatchObject([{ path: 'C:/Repos/Orca' }])
    expect(groups[0]?.path).not.toBe('C:\\Repos\\Orca')
  })

  it('keeps Windows drive roots as parent path labels', () => {
    const groups = groupWorktreesByParentPath([
      {
        id: 'windows-root-hidden',
        displayName: 'FeatureX',
        path: 'C:/'
      }
    ])

    expect(groups).toMatchObject([{ path: 'C:/' }])
  })

  it('keeps UNC share roots as parent path labels', () => {
    const groups = groupWorktreesByParentPath([
      {
        id: 'unc-root-hidden',
        displayName: 'ShareRoot',
        path: '\\\\server\\share'
      },
      {
        id: 'unc-repo-hidden',
        displayName: 'Repo',
        path: '\\\\server\\share\\repo'
      }
    ])

    expect(groups).toMatchObject([
      {
        path: '//server/share',
        worktrees: [{ id: 'unc-root-hidden' }, { id: 'unc-repo-hidden' }]
      }
    ])
  })

  it('disables actions while pending and renders inline errors', () => {
    const markup = renderLine({ pending: true, error: 'Could not show imported worktrees.' })

    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain('disabled=""')
    expect(markup).toContain('role="alert"')
    expect(markup).toContain('Could not show imported worktrees.')
  })
})

describe('ImportedWorktreesVisibilityLine in Japanese', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('ja')
  })

  afterAll(async () => {
    await i18n.changeLanguage('en')
  })

  it('translates the hidden worktrees line and its actions', () => {
    const markup = renderLine({ hostContextLabel: 'openclaw' })

    expect(markup).toContain('4 件のワークツリーを非表示中')
    expect(markup).toContain('orca（openclaw） の非表示のワークツリー一覧を展開')
    expect(markup).toContain(
      'orca（openclaw） で検出されたワークツリー 4 件を非表示のままにする（プロジェクトメニューから再表示できます）'
    )
    expect(markup).not.toContain('Hiding')
  })

  it('translates the pinned fallback line', () => {
    const markup = renderLine({ placement: 'pinned-fallback', onKeepHidden: undefined })

    expect(markup).toContain('orca の 4 件のワークツリーを非表示中')
  })
})
