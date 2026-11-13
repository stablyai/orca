// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Repo } from '../../../../../../shared/repo-types'
import { WorktreeCardRepoChip } from '../identity/worktree-card-header-items'
import { WorktreeCardMetaRepoBadge } from './worktree-card-meta-items'

const repo = { id: 'repo-1', displayName: 'orca', badgeColor: '#336699' } as Repo

afterEach(cleanup)

describe('project badges without the project name', () => {
  it.each([
    [
      'meta row badge',
      (showName: boolean) => <WorktreeCardMetaRepoBadge repo={repo} showName={showName} />
    ],
    ['header chip', (showName: boolean) => <WorktreeCardRepoChip repo={repo} showName={showName} />]
  ])('lets keyboard users reach the %s tooltip only when the name is hidden', (_name, badge) => {
    const hidden = render(<TooltipProvider>{badge(false)}</TooltipProvider>)
    const trigger = hidden.container.querySelector('[aria-label]')
    expect(trigger?.getAttribute('tabindex')).toBe('0')
    expect(trigger?.getAttribute('role')).toBe('img')
    expect(trigger?.getAttribute('aria-label')).toContain('orca')
    hidden.unmount()

    const shown = render(<TooltipProvider>{badge(true)}</TooltipProvider>)
    expect(shown.container.querySelector('[aria-label]')?.hasAttribute('tabindex')).toBe(false)
  })
})
