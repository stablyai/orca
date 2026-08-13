// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/types'

const { storeState } = vi.hoisted(() => ({
  storeState: {
    activeModal: 'confirm-remove-folder' as string,
    modalData: {} as Record<string, unknown>,
    closeModal: vi.fn(),
    repos: [] as Repo[],
    removeProject: vi.fn().mockResolvedValue(undefined),
    sshTargetLabels: new Map<string, string>(),
    removedSshTargetLabels: new Map<string, string>(),
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
  translate: (_key: string, fallback: string, values?: Record<string, string>) => {
    let result = fallback
    for (const [key, value] of Object.entries(values ?? {})) {
      result = result.replace(`{{${key}}}`, value)
    }
    return result
  }
}))

import RemoveFolderDialog from './RemoveFolderDialog'

/** The same repo id registered on two SSH hosts. */
function reposOnTwoHosts(): Repo[] {
  const base = { id: 'repo-1', badgeColor: '#000000', addedAt: 0, kind: 'git' as const }
  return [
    { ...base, path: '/repos/b', displayName: 'on host B', connectionId: 'host-b' },
    { ...base, path: '/repos/a', displayName: 'on host A', connectionId: 'host-a' }
  ] as unknown as Repo[]
}

afterEach(cleanup)

describe('RemoveFolderDialog host identity', () => {
  // Why: the opener carries the host and removeProject honours it, but nothing proved this
  // dialog forwards it between them. If it silently dropped the host, removal would resolve
  // through findRepoForHost's fallback and could tear down another host's project (#13071).
  it('forwards the modal host to removeProject', async () => {
    storeState.repos = reposOnTwoHosts()
    storeState.modalData = { repoId: 'repo-1', hostId: 'ssh:host-a', displayName: 'on host A' }
    storeState.removeProject = vi.fn().mockResolvedValue(undefined)

    render(<RemoveFolderDialog />)
    fireEvent.click(await screen.findByRole('button', { name: /^remove$/i }))

    expect(storeState.removeProject).toHaveBeenCalledWith('repo-1', {
      hostId: 'ssh:host-a',
      errorFeedback: 'toast'
    })
  })

  it('passes no host when the opener could not supply one', async () => {
    storeState.repos = reposOnTwoHosts()
    storeState.modalData = { repoId: 'repo-1', displayName: 'on host A' }
    storeState.removeProject = vi.fn().mockResolvedValue(undefined)

    render(<RemoveFolderDialog />)
    fireEvent.click(await screen.findByRole('button', { name: /^remove$/i }))

    expect(storeState.removeProject).toHaveBeenCalledWith('repo-1', {
      hostId: undefined,
      errorFeedback: 'toast'
    })
  })

  // Why: a malformed host must not be cast through — it should degrade to the previous
  // behaviour rather than be handed to removeProject as a bogus execution host.
  it('ignores a host that is not a valid execution host id', async () => {
    storeState.repos = reposOnTwoHosts()
    storeState.modalData = { repoId: 'repo-1', hostId: 'not-a-host', displayName: 'on host A' }
    storeState.removeProject = vi.fn().mockResolvedValue(undefined)

    render(<RemoveFolderDialog />)
    fireEvent.click(await screen.findByRole('button', { name: /^remove$/i }))

    expect(storeState.removeProject).toHaveBeenCalledWith('repo-1', {
      hostId: undefined,
      errorFeedback: 'toast'
    })
  })
})
