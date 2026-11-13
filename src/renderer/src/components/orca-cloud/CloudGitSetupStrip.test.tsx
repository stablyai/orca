// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CloudWorkspaceStatus } from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import { seedCloudWorkspaceSnapshot } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { seedCloudGitSetupState } from '@/lib/orca-cloud/cloud-git-setup-store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CloudGitSetupStrip } from './CloudGitSetupStrip'

function seed(gitSetupFailed: boolean, { paired = false }: { paired?: boolean } = {}): void {
  const status: CloudWorkspaceStatus = {
    state: 'ready',
    metrics: null,
    uptimeMs: null,
    usage: { totalMs: 0, centsPerHour: 75, costCents: 0 },
    archive: null,
    checkedAt: 1,
    ...(gitSetupFailed ? { gitSetupFailed: true as const } : {})
  }
  seedCloudWorkspaceSnapshot({
    // A paired row (created on another desktop) is registered apart from this desktop's own ids.
    ids: new Set(paired ? [] : ['w1']),
    paired: paired ? { w1: 'env-paired' } : {},
    idsLoaded: true,
    status: { w1: { status, loading: false, error: null, fetchedAt: 1 } }
  })
}

beforeEach(() => seedCloudGitSetupState({}))
afterEach(() => cleanup())

function strip(): Element | null {
  return render(
    <TooltipProvider>
      <CloudGitSetupStrip worktreeId="w1" />
    </TooltipProvider>
  ).container.querySelector('[data-cloud-git-setup-strip]')
}

describe('CloudGitSetupStrip', () => {
  it('is hidden while the setup hasn’t failed', () => {
    seed(false)
    expect(strip()).toBeNull()
  })

  it('shows once above the panes while it has failed, with Restart', () => {
    seed(true)
    const element = strip()
    expect(element?.getAttribute('data-cloud-git-setup-strip')).toBe('failed')
    expect(element?.textContent).toContain('Commits and pushes are off in this workspace')
    expect(element?.querySelector('button')?.textContent).toBe('Restart')
  })

  it('PAIRED-GIT-SETUP: a paired row gets the same strip and Restart', () => {
    seed(true, { paired: true })
    const element = strip()
    expect(element?.getAttribute('data-cloud-git-setup-strip')).toBe('failed')
    expect(element?.querySelector('button')?.textContent).toBe('Restart')
  })

  it('a row that is neither owned nor paired never shows it', () => {
    seed(true)
    seedCloudWorkspaceSnapshot({ ids: new Set(), idsLoaded: true })
    expect(strip()).toBeNull()
  })

  it('stays hidden after × for this session', () => {
    seed(true)
    seedCloudGitSetupState({ dismissed: { w1: true } })
    expect(strip()).toBeNull()
  })
})
