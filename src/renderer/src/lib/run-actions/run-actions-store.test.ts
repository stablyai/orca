import { afterEach, describe, expect, it, vi } from 'vitest'

const RUN = {
  worktreeId: 'repo::/w',
  repoId: 'repo',
  actionId: 'web',
  actionName: 'Web',
  tabId: 'tab-1',
  status: 'running',
  exitCode: null,
  startedAt: 1
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

function stubStorage(initial: Record<string, string>): Map<string, string> {
  const data = new Map(Object.entries(initial))
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value)
  })
  return data
}

describe('run-actions store persistence', () => {
  it('loads runs persisted by an earlier window at module load', async () => {
    stubStorage({ 'orca.runActions.v1': JSON.stringify({ 'repo::/w': { web: RUN } }) })
    const store = await import('./run-actions-store')
    expect(store.getRunActionRun('repo::/w', 'web')).toEqual(RUN)
  })

  it('drops malformed persisted entries', async () => {
    stubStorage({
      'orca.runActions.v1': JSON.stringify({
        'repo::/w': { web: { ...RUN, status: 'weird' }, ok: { ...RUN, actionId: 'ok' } }
      })
    })
    const store = await import('./run-actions-store')
    expect(store.listRunActionRuns().map((run) => run.actionId)).toEqual(['ok'])
  })

  it('writes every change back', async () => {
    const data = stubStorage({})
    const store = await import('./run-actions-store')
    store.setRunActionRun({ ...RUN, status: 'running' })
    store.patchRunActionRun('repo::/w', 'web', { status: 'stopped' })
    expect(JSON.parse(data.get('orca.runActions.v1')!)['repo::/w'].web.status).toBe('stopped')
  })
})
