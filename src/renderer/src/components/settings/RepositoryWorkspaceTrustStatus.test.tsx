// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceTrustEntry } from '../../../../shared/workspace-trust-types'
import { RepositoryWorkspaceTrustStatus } from './RepositoryWorkspaceTrustStatus'

const mocks = vi.hoisted(() => ({
  entries: [] as WorkspaceTrustEntry[]
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settings: unknown }) => unknown) =>
    selector({ settings: { workspaceTrustEntries: mocks.entries } })
}))

function entry(overrides: Partial<WorkspaceTrustEntry> & { path: string }): WorkspaceTrustEntry {
  return {
    id: `entry-${overrides.path}`,
    trusted: true,
    decidedAt: 1,
    origin: 'intake',
    ...overrides
  }
}

function repoAt(path: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path,
    displayName: 'Example Repo',
    badgeColor: '#000000',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

function stubWorkspaceTrustApi(
  overrides: Partial<{ decide: ReturnType<typeof vi.fn>; revoke: ReturnType<typeof vi.fn> }> = {}
): void {
  ;(window as unknown as { api: unknown }).api = {
    workspaceTrust: { decide: vi.fn(), revoke: vi.fn(), ...overrides }
  }
}

function renderCard(repo: Repo, entries: WorkspaceTrustEntry[]): ReturnType<typeof render> {
  mocks.entries = entries
  return render(<RepositoryWorkspaceTrustStatus repo={repo} />)
}

describe('RepositoryWorkspaceTrustStatus', () => {
  afterEach(() => {
    cleanup()
    mocks.entries = []
    delete (window as unknown as { api?: unknown }).api
  })

  it('renders the trusted-direct state for the repository path own grant', () => {
    renderCard(repoAt('/home/dev/work/proj'), [entry({ path: '/home/dev/work/proj' })])

    expect(screen.getByText('Trusted')).toBeTruthy()
    expect(screen.getByText(/\/home\/dev\/work\/proj/)).toBeTruthy()
  })

  it('renders the trusted-inherited state when only an ancestor is trusted', () => {
    renderCard(repoAt('/home/dev/work/proj'), [entry({ path: '/home/dev/work' })])

    expect(screen.getByText('Trust inherited from /home/dev/work')).toBeTruthy()
  })

  it('renders the untrusted state for a remembered decline', () => {
    renderCard(repoAt('/home/dev/work/proj'), [
      entry({ path: '/home/dev/work/proj', trusted: false })
    ])

    expect(screen.getByText('Not trusted')).toBeTruthy()
    expect(screen.getByText(/You declined trust/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Trust this project' })).toBeTruthy()
  })

  it('renders the not-applicable state, with no action, for a remote-hosted project', () => {
    renderCard(repoAt('/srv/proj', { connectionId: 'builder' }), [])

    expect(screen.getByText('Not applicable')).toBeTruthy()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  // Not-applicable (remote) and no-decision-yet (local, zero entries) must never
  // collapse: a remote project has no local root to gate, while an entry-less local
  // repo is simply undecided and fails closed with a grant action still offered.
  it('renders a local repository with no matching entry as untrusted, not not-applicable', () => {
    renderCard(repoAt('/home/dev/work/proj'), [entry({ path: '/home/dev/elsewhere' })])

    expect(screen.queryByText('Not applicable')).toBeNull()
    expect(screen.getByText('Not trusted')).toBeTruthy()
    expect(screen.getByText(/No trust decision is recorded/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Trust this project' })).toBeTruthy()
  })

  it('offers both the project decline and the ancestor revoke when trust is inherited', () => {
    const decide = vi.fn()
    const revoke = vi.fn()
    stubWorkspaceTrustApi({ decide, revoke })
    renderCard(repoAt('/home/dev/work/proj'), [
      entry({ path: '/home/dev/work', id: 'ancestor-entry' })
    ])

    fireEvent.click(screen.getByRole('button', { name: "Don't trust this project" }))
    expect(decide).toHaveBeenCalledWith({
      target: { kind: 'repo', repoId: 'repo-1' },
      scope: 'workspace',
      decision: 'decline'
    })

    fireEvent.click(screen.getByRole('button', { name: 'Revoke trust for /home/dev/work' }))
    expect(revoke).toHaveBeenCalledWith({ entryId: 'ancestor-entry' })
  })

  // Revocation is a settings write that the next capability query reads; the card must not
  // fake the new state locally, and must not reach for anything that could stop live work.
  it('revokes a direct grant by entry id and leaves the rendered state to the next query', () => {
    const decide = vi.fn()
    const revoke = vi.fn()
    stubWorkspaceTrustApi({ decide, revoke })
    renderCard(repoAt('/home/dev/work/proj'), [
      entry({ path: '/home/dev/work/proj', id: 'direct-entry' })
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Revoke trust' }))

    expect(revoke).toHaveBeenCalledWith({ entryId: 'direct-entry' })
    expect(decide).not.toHaveBeenCalled()
    expect(screen.getByText('Trusted')).toBeTruthy()
  })

  // A trust change made anywhere else lands in the renderer's settings through
  // `settings:changed`; the card must repaint from that state alone, never from a refresh.
  it('reflects a trust change made elsewhere without a manual refresh', () => {
    const repo = repoAt('/home/dev/work/proj')
    const view = renderCard(repo, [])
    expect(screen.getByText('Not trusted')).toBeTruthy()

    mocks.entries = [entry({ path: '/home/dev/work/proj' })]
    view.rerender(<RepositoryWorkspaceTrustStatus repo={repo} />)

    expect(screen.getByText('Trusted')).toBeTruthy()
  })

  it('derives its state synchronously from settings, with no effect-driven fetch', () => {
    const source = readFileSync(join(__dirname, 'RepositoryWorkspaceTrustStatus.tsx'), 'utf8')

    expect(source).not.toContain('useEffect')
    expect(source).not.toContain('settings.get')
  })
})
