// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { GitSubmoduleRepo } from '../../../../../../shared/git-submodule-repo-types'
import { SourceControlSubmoduleReposSection } from './submodule-repos-section'

afterEach(cleanup)

const TRACKING: GitSubmoduleRepo = {
  path: 'libs/tracking',
  branch: 'main',
  upstream: { hasUpstream: true, upstreamName: 'origin/main', ahead: 2, behind: 1 }
}
const DETACHED: GitSubmoduleRepo = { path: 'libs/detached', branch: null, upstream: null }
const UNPUBLISHED: GitSubmoduleRepo = {
  path: 'libs/unpublished',
  branch: 'topic',
  upstream: { hasUpstream: false, ahead: 0, behind: 0 }
}

function renderSection(
  repos: GitSubmoduleRepo[],
  busy: { path: string; action: 'fetch' | 'pull' | 'push' } | null = null
) {
  const runAction = vi.fn().mockResolvedValue(undefined)
  render(
    <TooltipProvider>
      <SourceControlSubmoduleReposSection repos={repos} busy={busy} runAction={runAction} />
    </TooltipProvider>
  )
  return runAction
}

describe('SourceControlSubmoduleReposSection', () => {
  it('renders nothing when there are no submodules', () => {
    renderSection([])
    expect(screen.queryByText('Submodules')).toBeNull()
  })

  it('shows the branch and ahead/behind of each submodule', () => {
    renderSection([TRACKING, DETACHED])
    expect(screen.getByText('Submodules')).toBeInTheDocument()
    expect(screen.getByText('main')).toBeInTheDocument()
    expect(screen.getByText('↓1↑2')).toBeInTheDocument()
    expect(screen.getByText('Detached HEAD')).toBeInTheDocument()
  })

  it('runs the action on the submodule whose button was clicked', () => {
    const runAction = renderSection([TRACKING, UNPUBLISHED])
    fireEvent.click(screen.getByRole('button', { name: 'Pull tracking' }))
    fireEvent.click(screen.getByRole('button', { name: 'Push unpublished' }))
    expect(runAction).toHaveBeenNthCalledWith(1, 'libs/tracking', 'pull')
    expect(runAction).toHaveBeenNthCalledWith(2, 'libs/unpublished', 'push')
  })

  it('allows only fetch on a detached HEAD', () => {
    const runAction = renderSection([DETACHED])
    fireEvent.click(screen.getByRole('button', { name: 'Pull detached' }))
    fireEvent.click(screen.getByRole('button', { name: 'Push detached' }))
    expect(runAction).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Fetch detached' }))
    expect(runAction).toHaveBeenCalledWith('libs/detached', 'fetch')
  })

  it('does not pull a branch without an upstream, and publishes it with push', () => {
    const runAction = renderSection([UNPUBLISHED])
    fireEvent.click(screen.getByRole('button', { name: 'Pull unpublished' }))
    expect(runAction).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Push unpublished' }))
    expect(runAction).toHaveBeenCalledWith('libs/unpublished', 'push')
  })

  it('does not push a branch with nothing to push', () => {
    const upToDate: GitSubmoduleRepo = {
      path: 'libs/clean',
      branch: 'main',
      upstream: { hasUpstream: true, upstreamName: 'origin/main', ahead: 0, behind: 0 }
    }
    const runAction = renderSection([upToDate])
    fireEvent.click(screen.getByRole('button', { name: 'Push clean' }))
    expect(runAction).not.toHaveBeenCalled()
  })

  it('blocks every button while an action runs', () => {
    const runAction = renderSection([TRACKING], { path: 'libs/tracking', action: 'pull' })
    fireEvent.click(screen.getByRole('button', { name: 'Fetch tracking' }))
    fireEvent.click(screen.getByRole('button', { name: 'Push tracking' }))
    expect(runAction).not.toHaveBeenCalled()
  })
})
