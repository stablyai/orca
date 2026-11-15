// CREATE-GH-STEP: the wizard's GitHub access step. Checked with the create, held before Open only
// when access is missing, released by a grant (polled) or Skip, and a skip is remembered per repo.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  type Listener = (state: { pendingWorktreeCreations: Record<string, unknown> }) => void
  const store = {
    state: {
      pendingWorktreeCreations: { c1: {} } as Record<string, unknown>,
      activePendingCreationId: 'c1' as string | null
    },
    listeners: new Set<Listener>()
  }
  return {
    store,
    answers: [] as unknown[],
    pushAccess: 'install' as string,
    install: vi.fn(async () => true),
    openUrl: vi.fn(async () => undefined),
    shown: true
  }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.store.state,
    subscribe: (listener: (state: unknown) => void) => {
      mocks.store.listeners.add(listener)
      return () => mocks.store.listeners.delete(listener)
    }
  }
}))
vi.mock('@/lib/workspace/creation/worktree-creation-surface', () => ({
  selectWorktreeCreationSurfaceShown: () => mocks.shown
}))
vi.mock('./use-orca-cloud-repo-access', () => ({
  fetchOrcaCloudRepoAccess: async () =>
    mocks.answers.length > 1 ? mocks.answers.shift() : mocks.answers[0],
  invalidateOrcaCloudRepoAccess: () => undefined
}))
vi.mock('./cloud-push-access', () => ({
  fetchCloudPushAccess: async () => mocks.pushAccess
}))
vi.mock('./cloud-setup-notice-actions', () => ({
  openOrcaGitHubAppInstall: mocks.install
}))

import {
  beginCloudCreateGitHubAccess,
  disposeCloudCreateGitHubAccess,
  gateCloudCreateOnGitHubAccess,
  openCloudCreateGitHubAccess,
  reopenCloudCreateGitHubAccess,
  skipCloudCreateGitHubAccess
} from './cloud-create-github-access'
import { getCloudCreateGitHubAccess } from './cloud-create-github-access-registry'
import { isGitHubAccessSkipped, rememberGitHubAccessSkip } from './cloud-create-github-skip'

const REPO = 'https://github.com/acme/site'
const base = { owner: 'acme', repo: REPO }
const NOT_INSTALLED = { ...base, access: 'public', push: 'not_installed', canInstall: null }
const GRANTED = { ...base, access: 'granted', push: 'ok' }

async function settled(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}

function removeCreation(): void {
  delete mocks.store.state.pendingWorktreeCreations.c1
  for (const listener of mocks.store.listeners) {
    listener(mocks.store.state)
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key)
  })
  vi.stubGlobal('window', { api: { shell: { openUrl: mocks.openUrl } } })
  mocks.store.state.pendingWorktreeCreations = { c1: {} }
  mocks.store.state.activePendingCreationId = 'c1'
  mocks.answers = []
  mocks.pushAccess = 'install'
  mocks.shown = true
  mocks.install.mockClear()
  mocks.openUrl.mockClear()
})

afterEach(() => {
  disposeCloudCreateGitHubAccess('c1')
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the create wizard’s GitHub access step', () => {
  it('access already fine: a check mark, and Open is never held', async () => {
    mocks.answers = [GRANTED]
    beginCloudCreateGitHubAccess('c1', REPO)
    expect(getCloudCreateGitHubAccess('c1')?.phase).toBe('checking')
    await settled()
    expect(getCloudCreateGitHubAccess('c1')?.phase).toBe('ok')
    await expect(gateCloudCreateOnGitHubAccess('c1')).resolves.toEqual({
      proceed: true,
      grantedDuringCreate: false
    })
  })

  it('the gate waits for the first answer instead of passing a create that needs access', async () => {
    let answer: (value: unknown) => void = () => undefined
    mocks.answers = [new Promise((resolve) => (answer = resolve))]
    beginCloudCreateGitHubAccess('c1', REPO)
    let gate: unknown = null
    void gateCloudCreateOnGitHubAccess('c1').then((value) => (gate = value))
    answer(NOT_INSTALLED)
    await settled()
    expect(getCloudCreateGitHubAccess('c1')).toMatchObject({
      phase: 'needed',
      ask: 'install',
      holding: true
    })
    expect(gate).toBeNull()
  })

  it('missing: Install opens GitHub, the poll sees the grant, and Open goes on with it', async () => {
    mocks.answers = [NOT_INSTALLED]
    beginCloudCreateGitHubAccess('c1', REPO)
    await settled()
    let gate: unknown = null
    void gateCloudCreateOnGitHubAccess('c1').then((value) => (gate = value))
    await settled()
    openCloudCreateGitHubAccess('c1')
    await settled()
    expect(mocks.install).toHaveBeenCalledWith(REPO)
    expect(getCloudCreateGitHubAccess('c1')?.opened).toBe(true)
    mocks.answers = [GRANTED]
    await vi.advanceTimersByTimeAsync(2_000)
    await settled()
    expect(getCloudCreateGitHubAccess('c1')).toMatchObject({ phase: 'granted', holding: false })
    expect(gate).toEqual({ proceed: true, grantedDuringCreate: true })
  })

  it('installed on the owner without this repository: opens its settings page', async () => {
    const settings = 'https://github.com/organizations/acme/settings/installations/900'
    mocks.answers = [
      { ...base, access: 'public', push: 'repo_not_selected', configureUrl: settings }
    ]
    beginCloudCreateGitHubAccess('c1', REPO)
    await settled()
    expect(getCloudCreateGitHubAccess('c1')).toMatchObject({
      ask: 'configure',
      configureUrl: settings
    })
    openCloudCreateGitHubAccess('c1')
    await settled()
    expect(mocks.openUrl).toHaveBeenCalledWith(settings)
    expect(mocks.install).not.toHaveBeenCalled()
  })

  it('only an owner can install: a request to copy', async () => {
    mocks.answers = [{ ...NOT_INSTALLED, canInstall: false }]
    beginCloudCreateGitHubAccess('c1', REPO)
    await settled()
    expect(getCloudCreateGitHubAccess('c1')?.ask).toBe('request')
    mocks.answers = [{ ...NOT_INSTALLED }]
    mocks.pushAccess = 'cantInstall'
    beginCloudCreateGitHubAccess('c1', REPO)
    await settled()
    expect(getCloudCreateGitHubAccess('c1')?.ask).toBe('request')
  })

  it('Skip for now: Open goes on, and the next create of the repository isn’t held', async () => {
    mocks.answers = [NOT_INSTALLED]
    beginCloudCreateGitHubAccess('c1', REPO)
    await settled()
    const gate = gateCloudCreateOnGitHubAccess('c1')
    await settled()
    skipCloudCreateGitHubAccess('c1')
    await expect(gate).resolves.toEqual({ proceed: true, grantedDuringCreate: false })
    expect(isGitHubAccessSkipped(REPO)).toBe(true)

    beginCloudCreateGitHubAccess('c1', REPO)
    await settled()
    expect(getCloudCreateGitHubAccess('c1')).toMatchObject({ phase: 'skipped', remembered: true })
    await expect(gateCloudCreateOnGitHubAccess('c1')).resolves.toMatchObject({ proceed: true })
    // Set up asks again (and polls) without holding the create.
    reopenCloudCreateGitHubAccess('c1')
    expect(getCloudCreateGitHubAccess('c1')?.phase).toBe('needed')
    expect(isGitHubAccessSkipped(REPO)).toBe(false)
  })

  it('a remembered skip is dropped once the repository has access', async () => {
    rememberGitHubAccessSkip(REPO)
    mocks.answers = [GRANTED]
    beginCloudCreateGitHubAccess('c1', REPO)
    await settled()
    expect(getCloudCreateGitHubAccess('c1')?.phase).toBe('ok')
    expect(isGitHubAccessSkipped(REPO)).toBe(false)
  })

  it('a create whose sheet isn’t on screen isn’t held', async () => {
    mocks.answers = [NOT_INSTALLED]
    mocks.shown = false
    beginCloudCreateGitHubAccess('c1', REPO)
    await settled()
    await expect(gateCloudCreateOnGitHubAccess('c1')).resolves.toEqual({
      proceed: true,
      grantedDuringCreate: false
    })
    expect(isGitHubAccessSkipped(REPO)).toBe(false)
  })

  it('cancelled while held: the wait ends with proceed false and polling stops', async () => {
    mocks.answers = [NOT_INSTALLED]
    beginCloudCreateGitHubAccess('c1', REPO)
    await settled()
    const gate = gateCloudCreateOnGitHubAccess('c1')
    await settled()
    removeCreation()
    await expect(gate).resolves.toEqual({ proceed: false, grantedDuringCreate: false })
    expect(getCloudCreateGitHubAccess('c1')).toBeNull()
  })

  it('no answer (signed out, offline) or an older control plane: no step', async () => {
    mocks.answers = [null]
    beginCloudCreateGitHubAccess('c1', REPO)
    await settled()
    expect(getCloudCreateGitHubAccess('c1')?.phase).toBe('hidden')
    mocks.answers = [{ ...base, access: 'public' }]
    beginCloudCreateGitHubAccess('c1', REPO)
    await settled()
    expect(getCloudCreateGitHubAccess('c1')?.phase).toBe('hidden')
    beginCloudCreateGitHubAccess('c1', null)
    expect(getCloudCreateGitHubAccess('c1')).toBeNull()
  })
})
