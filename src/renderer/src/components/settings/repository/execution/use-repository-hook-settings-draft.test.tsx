// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import { useRepositoryHookSettingsDraft } from './use-repository-hook-settings-draft'

type DraftController = ReturnType<typeof useRepositoryHookSettingsDraft>
let latest: DraftController | null = null
let root: Root | null = null
let container: HTMLDivElement | null = null

const baseRepo: Repo = {
  id: 'repo-1',
  kind: 'git',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: 'blue',
  addedAt: 1,
  gitUsername: '',
  hookSettings: {
    mode: 'auto',
    setupRunPolicy: 'run-by-default',
    setupAgentStartupPolicy: 'start-immediately',
    commandSourcePolicy: 'shared-only',
    scripts: { setup: '', archive: '' }
  }
}

function Harness({
  repo,
  identity,
  persist
}: {
  repo: Repo
  identity: string
  persist: (settings: NonNullable<Repo['hookSettings']>) => void
}): null {
  latest = useRepositoryHookSettingsDraft({
    repo,
    repoHostIdentity: identity,
    onUpdateHookSettings: persist
  })
  return null
}

function renderHarness(
  repo: Repo,
  identity: string,
  persist: (settings: NonNullable<Repo['hookSettings']>) => void
): void {
  if (!root) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  }
  act(() => root?.render(<Harness repo={repo} identity={identity} persist={persist} />))
}

beforeEach(() => vi.useFakeTimers())

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  latest = null
  vi.useRealTimers()
})

describe('repository hook draft persistence', () => {
  it('flushes a host switch through the previous owner before resetting the draft', () => {
    const localPersist = vi.fn()
    const remotePersist = vi.fn()
    renderHarness(baseRepo, 'local\0repo-1', localPersist)
    act(() => latest?.updateScriptDraft('setup', 'local draft'))

    renderHarness(
      {
        ...baseRepo,
        hookSettings: { ...baseRepo.hookSettings!, scripts: { setup: 'remote', archive: '' } }
      },
      'runtime:server-1\0repo-1',
      remotePersist
    )

    expect(localPersist).toHaveBeenCalledTimes(1)
    expect(localPersist.mock.calls[0][0].scripts.setup).toBe('local draft')
    expect(remotePersist).not.toHaveBeenCalled()
    expect(latest?.hookSettingsDraft.scripts.setup).toBe('remote')
  })
})
