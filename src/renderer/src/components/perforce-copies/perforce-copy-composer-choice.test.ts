import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'

const state: { repos: Repo[] } = { repos: [] }
const readiness = vi.hoisted(() => ({ ready: true, ok: true, calls: 0 }))

vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
vi.mock('@/lib/perforce-workspace-target', () => ({
  perforceProjectTarget: (repoId: string) => ({ repoId })
}))
vi.mock('../../runtime/runtime-perforce-client', () => ({
  runPerforceCopyOperation: async () => {
    readiness.calls += 1
    return readiness.ok
      ? { ok: true, value: { ready: readiness.ready } }
      : { ok: false, error: 'host unreachable' }
  }
}))

import {
  checkPerforceCopyReadiness,
  perforceCopyChoiceKey,
  resolvePerforceCopyComposerChoice,
  usePerforceCopyComposerChoiceStore
} from './perforce-copy-composer-choice'

function repo(id: string, patch: Partial<Repo>): Repo {
  return {
    id,
    path: `D:\\${id}`,
    displayName: id,
    badgeColor: '#888888',
    addedAt: 0,
    ...patch
  }
}

describe('resolvePerforceCopyComposerChoice', () => {
  beforeEach(() => {
    state.repos = [
      repo('git', {}),
      repo('folder', { kind: 'folder' }),
      repo('p4', { kind: 'folder', vcs: 'perforce' })
    ]
    usePerforceCopyComposerChoiceStore.setState({ byRepo: {} })
    Object.assign(readiness, { ready: true, ok: true, calls: 0 })
  })

  it('makes no copy outside a Perforce project', async () => {
    await expect(resolvePerforceCopyComposerChoice('git')).resolves.toBeUndefined()
    await expect(resolvePerforceCopyComposerChoice('folder')).resolves.toBeUndefined()
    await expect(resolvePerforceCopyComposerChoice('missing')).resolves.toBeUndefined()
    expect(readiness.calls).toBe(0)
  })

  it("waits for the host's answer when the composer has not had one yet", async () => {
    await expect(resolvePerforceCopyComposerChoice('p4')).resolves.toEqual({
      stream: { kind: 'child' }
    })
    readiness.ready = false
    usePerforceCopyComposerChoiceStore.setState({ byRepo: {} })
    await expect(resolvePerforceCopyComposerChoice('p4')).resolves.toBeUndefined()
    readiness.ok = false
    usePerforceCopyComposerChoiceStore.setState({ byRepo: {} })
    await expect(resolvePerforceCopyComposerChoice('p4')).resolves.toBeUndefined()
  })

  it('shares one check between the composer and a create', async () => {
    const composer = checkPerforceCopyReadiness('p4', null)
    await resolvePerforceCopyComposerChoice('p4')
    await composer
    expect(readiness.calls).toBe(1)
  })

  it("uses the chosen base once answered, and shares the folder when the host can't copy", async () => {
    const { setChoice } = usePerforceCopyComposerChoiceStore.getState()
    setChoice(perforceCopyChoiceKey('p4', null), {
      stream: { kind: 'child', parent: '//game/dev' },
      ready: true
    })
    await expect(resolvePerforceCopyComposerChoice('p4')).resolves.toEqual({
      stream: { kind: 'child', parent: '//game/dev' }
    })
    setChoice(perforceCopyChoiceKey('p4', null), { ready: false })
    await expect(resolvePerforceCopyComposerChoice('p4')).resolves.toBeUndefined()
    expect(readiness.calls).toBe(0)
  })

  it('reads the project on the host the composer picked', async () => {
    state.repos = [
      repo('dup', { kind: 'folder' }),
      repo('dup', { kind: 'folder', vcs: 'perforce', executionHostId: 'ssh:build-box' })
    ]
    await expect(resolvePerforceCopyComposerChoice('dup', 'ssh:build-box')).resolves.toEqual({
      stream: { kind: 'child' }
    })
    await expect(resolvePerforceCopyComposerChoice('dup', 'local')).resolves.toBeUndefined()
  })
})
