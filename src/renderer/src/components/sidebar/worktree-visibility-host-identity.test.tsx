// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/types'

const { storeState } = vi.hoisted(() => ({
  storeState: {
    activeModal: 'worktree-visibility' as string,
    modalData: {} as Record<string, unknown>,
    closeModal: vi.fn(),
    repos: [] as Repo[],
    updateRepo: vi.fn().mockResolvedValue(true),
    fetchWorktrees: vi.fn().mockResolvedValue(true),
    detectedWorktreesByRepo: {} as Record<string, unknown>,
    settings: {} as Record<string, unknown>
  }
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState }
  )
}))

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))

import WorktreeVisibilityDialog from './WorktreeVisibilityDialog'

/** Same repo id on two hosts; only host-a currently shows its external worktrees. */
function reposOnTwoHosts(): Repo[] {
  const base = { id: 'repo-1', badgeColor: '#000000', addedAt: 0, kind: 'git' as const }
  return [
    {
      ...base,
      path: '/repos/b',
      displayName: 'on host B',
      connectionId: 'host-b',
      externalWorktreeVisibility: 'hide'
    },
    {
      ...base,
      path: '/repos/a',
      displayName: 'on host A',
      connectionId: 'host-a',
      externalWorktreeVisibility: 'show'
    }
  ] as unknown as Repo[]
}

afterEach(cleanup)

describe('WorktreeVisibilityDialog host identity', () => {
  // Why: one repo id can exist on several hosts. Resolved by bare id, the dialog reads whichever
  // row matches first — so it can show host B's state while the user opened it for host A, then
  // write the toggle to the wrong row.
  it('writes the toggle to the host the dialog was opened for', async () => {
    storeState.repos = reposOnTwoHosts()
    storeState.modalData = { repoId: 'repo-1', hostId: 'ssh:host-a' }
    storeState.updateRepo = vi.fn().mockResolvedValue(true)

    render(<WorktreeVisibilityDialog />)
    fireEvent.click(await screen.findByRole('button', { name: /import|hide/i }))

    expect(storeState.updateRepo).toHaveBeenCalledWith(
      'repo-1',
      expect.objectContaining({ externalWorktreeVisibility: 'hide' }),
      { hostId: 'ssh:host-a' }
    )
  })

  it('omits the host option when the caller could not supply one', async () => {
    storeState.repos = reposOnTwoHosts()
    storeState.modalData = { repoId: 'repo-1' }
    storeState.updateRepo = vi.fn().mockResolvedValue(true)

    render(<WorktreeVisibilityDialog />)
    fireEvent.click(await screen.findByRole('button', { name: /import|hide/i }))

    expect(storeState.updateRepo).toHaveBeenCalledWith(
      'repo-1',
      expect.objectContaining({}),
      undefined
    )
  })
})
