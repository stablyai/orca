import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '../../../../shared/update-status-types'
import type { AppUpdateBatch } from '../../../../shared/app-update-batch'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { createAppUpdateActions, type AppUpdateSlice } from './app-update'

function setup(ids = ['one', 'two']) {
  const hosts = new Map(
    ids.map((id) => [
      id,
      {
        downloaded: false,
        installed: false,
        target: '1.6.0',
        failDownload: false,
        loseInstallReply: false,
        pairingRevision: 1,
        supportsPinned: true
      }
    ])
  )
  let saved: AppUpdateBatch | null = null
  let currentVersion = '1.5.0'
  let state: AppUpdateSlice & {
    updateStatus: UpdateStatus
    remoteServerUpdatesRunning: boolean
    remoteServerUpdatesChecking: boolean
  }
  state = {
    ...createAppUpdateActions(
      (partial) => {
        state = { ...state, ...partial }
      },
      () => state
    ),
    updateStatus: { state: 'available', version: '1.6.0', changelog: null },
    remoteServerUpdatesRunning: false,
    remoteServerUpdatesChecking: false
  }
  const checkpoints: (AppUpdateBatch | null)[] = []
  const events: string[] = []
  const runtimeStatus = (id: string): RuntimeStatus => ({
    runtimeId: `${id}-${hosts.get(id)?.installed ? 'new' : 'old'}`,
    appVersion: hosts.get(id)?.installed ? '1.6.0' : '1.5.0',
    rendererGraphEpoch: 0,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 1,
    liveLeafCount: 1,
    capabilities: [
      'updater.remote-control.v1',
      ...(hosts.get(id)?.supportsPinned ? ['updater.target-version.v1'] : [])
    ],
    remoteUpdateSupport: {
      automatic: true,
      installMode: 'supervised-headless-serve',
      reason: 'available'
    }
  })
  const installLocal = vi.fn(async () => {
    events.push('local-install')
  })
  const downloadLocal = vi.fn(async () => {
    state.updateStatus = { state: 'downloaded', version: '1.6.0' }
  })
  const setUI = vi.fn(async (ui: { appUpdateBatch?: AppUpdateBatch | null }) => {
    if ('appUpdateBatch' in ui) {
      saved = structuredClone(ui.appUpdateBatch ?? null)
      checkpoints.push(saved)
      events.push('checkpoint')
    }
  })
  const remoteCall = vi.fn(
    async ({
      selector,
      method,
      expectedEnvironmentPairingRevision
    }: {
      selector: string
      method: string
      expectedEnvironmentPairingRevision?: number
    }) => {
      const host = hosts.get(selector)
      if (!host) {
        throw new Error('offline')
      }
      if (expectedEnvironmentPairingRevision !== host.pairingRevision) {
        return {
          ok: false,
          error: { code: 'runtime_environment_changed', message: 'Pairing changed' }
        }
      }
      if (method === 'status.get') {
        return { ok: true, result: runtimeStatus(selector) }
      }
      if (method === 'updater.download') {
        if (host.failDownload) {
          throw new Error('Disk full')
        }
        host.downloaded = true
        events.push(`${selector}-downloaded`)
      }
      if (method === 'updater.install') {
        expect(saved?.remotes.find((remote) => remote.environmentId === selector)?.phase).toBe(
          'restarting'
        )
        expect(state.updateStatus.state === 'downloaded' || currentVersion === '1.6.0').toBe(true)
        events.push(`${selector}-install`)
        if (host.loseInstallReply) {
          throw new Error('connection lost')
        }
        host.installed = true
        return {
          ok: true,
          result: {
            accepted: true,
            fromVersion: '1.5.0',
            targetVersion: host.target,
            runtimeId: `${selector}-old`
          }
        }
      }
      const status: UpdateStatus = host.downloaded
        ? { state: 'downloaded', version: host.target }
        : { state: 'available', version: host.target, changelog: null }
      return {
        ok: true,
        result: {
          appVersion: '1.5.0',
          runtimeId: `${selector}-old`,
          support: runtimeStatus(selector).remoteUpdateSupport,
          status
        }
      }
    }
  )
  const environments: PublicKnownRuntimeEnvironment[] = ids.map((id) => ({
    id,
    name: id,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [{ id: `${id}-ws`, kind: 'websocket', label: 'WebSocket', endpoint: `ws://${id}` }],
    preferredEndpointId: `${id}-ws`
  }))
  vi.stubGlobal('window', {
    setTimeout,
    api: {
      ui: { set: setUI, get: async () => ({ appUpdateBatch: saved }) },
      updater: {
        download: downloadLocal,
        quitAndInstall: installLocal,
        getVersion: async () => currentVersion
      },
      runtimeEnvironments: {
        list: async () => environments,
        getStatus: async ({ selector }: { selector: string }) => ({
          ok: true,
          result: runtimeStatus(selector)
        }),
        call: remoteCall
      }
    }
  })
  return {
    get: () => state,
    hosts,
    events,
    checkpoints,
    installLocal,
    downloadLocal,
    remoteCall,
    setUI,
    setStatus: (status: UpdateStatus) => {
      state.updateStatus = status
    },
    setSaved: (batch: AppUpdateBatch) => {
      saved = batch
    },
    setVersion: (version: string) => {
      currentVersion = version
    }
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('combined app and remote update', () => {
  it('finds offered updates even when a remote matches the installed client, stages locally first, then restarts locally last', async () => {
    const test = setup()
    let releaseDownload: (() => void) | undefined
    test.downloadLocal.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseDownload = () => {
            test.setStatus({ state: 'downloaded', version: '1.6.0' })
            resolve()
          }
        })
    )
    await test.get().discoverAppUpdateRemotes('1.6.0')
    expect(test.get().appUpdateCandidates).toHaveLength(2)
    const pending = test.get().startAppUpdate()
    await vi.waitFor(() => expect(test.events).toContain('two-downloaded'))
    expect(test.events.filter((event) => event.endsWith('-install'))).toEqual([])
    releaseDownload?.()
    await pending
    expect(test.events.filter((event) => event.endsWith('-install'))).toEqual([
      'one-install',
      'two-install',
      'local-install'
    ])
    expect(test.get().appUpdateBatch?.remotes.every((remote) => remote.phase === 'updated')).toBe(
      true
    )
  })

  it('does not restart any remote if the local package cannot download', async () => {
    const test = setup()
    test.downloadLocal.mockRejectedValue(new Error('local checksum mismatch'))
    await test.get().startAppUpdate()
    expect(test.events).toContain('one-downloaded')
    expect(test.events.filter((event) => event.endsWith('-install'))).toEqual([])
    expect(test.get().appUpdateBatch).toMatchObject({
      stage: 'attention',
      error: 'local checksum mismatch'
    })
  })

  it('continues healthy remotes, holds the local restart, and retries only the failed host', async () => {
    const test = setup()
    const one = test.hosts.get('one')
    if (!one) {
      throw new Error('missing fixture host')
    }
    one.failDownload = true
    await test.get().startAppUpdate()
    expect(test.events).toContain('two-install')
    expect(test.installLocal).not.toHaveBeenCalled()
    expect(test.get().appUpdateBatch?.stage).toBe('attention')
    one.failDownload = false
    await test.get().retryAppUpdateRemote('one')
    expect(test.events.filter((event) => event === 'two-install')).toHaveLength(1)
    expect(test.installLocal).toHaveBeenCalledOnce()
  })

  it('Okay retains failures durably and proceeds with the local update', async () => {
    const test = setup()
    for (const host of test.hosts.values()) {
      host.failDownload = true
    }
    await test.get().startAppUpdate()
    await test.get().continueAppUpdate()
    expect(test.installLocal).toHaveBeenCalledOnce()
    expect(test.checkpoints.at(-1)).toMatchObject({
      stage: 'installing',
      remotes: [
        expect.objectContaining({ phase: 'failed' }),
        expect.objectContaining({ phase: 'failed' })
      ]
    })
  })

  it('rechecks an ambiguous install without reinstalling it, including after a local restart', async () => {
    const test = setup(['one'])
    const host = test.hosts.get('one')
    if (!host) {
      throw new Error('missing fixture host')
    }
    host.loseInstallReply = true
    await test.get().startAppUpdate()
    expect(test.get().appUpdateBatch?.remotes[0]?.phase).toBe('not-confirmed')
    await test.get().retryAppUpdateRemote('one')
    expect(test.events.filter((event) => event === 'one-install')).toHaveLength(1)
    const batch = test.get().appUpdateBatch
    if (!batch) {
      throw new Error('missing saved batch')
    }
    const restarted = setup(['one'])
    restarted.setVersion('1.6.0')
    restarted.setSaved(batch)
    await restarted.get().restoreAppUpdate()
    expect(restarted.get().appUpdateBatch?.remotes[0]?.phase).toBe('not-confirmed')
    expect(restarted.remoteCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'updater.install' })
    )
    const replacement = restarted.hosts.get('one')
    if (!replacement) {
      throw new Error('missing fixture host')
    }
    replacement.installed = true
    await restarted.get().retryAppUpdateRemote('one')
    expect(restarted.get().appUpdateBatch?.remotes[0]?.phase).toBe('updated')
    expect(restarted.installLocal).not.toHaveBeenCalled()
  })

  it('refuses an install if its recovery checkpoint cannot be saved', async () => {
    const test = setup(['one'])
    test.setUI.mockImplementation(async (ui) => {
      if (ui.appUpdateBatch?.remotes.some((remote) => remote.phase === 'restarting')) {
        throw new Error('profile write failed')
      }
    })
    await test.get().startAppUpdate()
    expect(test.events).not.toContain('one-install')
    expect(test.installLocal).not.toHaveBeenCalled()
    expect(test.get().appUpdateBatch?.remotes[0]).toMatchObject({
      phase: 'failed',
      error: 'profile write failed'
    })
  })

  it('freezes the reviewed remote target if a newer release appears before download', async () => {
    const test = setup(['one'])
    await test.get().discoverAppUpdateRemotes('1.6.0')
    const host = test.hosts.get('one')
    if (!host) {
      throw new Error('missing fixture host')
    }
    host.target = '1.7.0'
    await test.get().startAppUpdate()
    expect(test.get().appUpdateBatch?.remotes[0]?.phase).toBe('failed')
    expect(test.events).not.toContain('one-install')
  })
})

it('cannot redirect an approved install to a same-ID re-paired host', async () => {
  const test = setup(['one'])
  let release: (() => void) | undefined
  test.downloadLocal.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = () => {
          test.setStatus({ state: 'downloaded', version: '1.6.0' })
          resolve()
        }
      })
  )
  const pending = test.get().startAppUpdate()
  await vi.waitFor(() => expect(test.events).toContain('one-downloaded'))
  const host = test.hosts.get('one')
  if (!host) {
    throw new Error('missing fixture host')
  }
  host.pairingRevision = 2
  release?.()
  await pending
  expect(test.events).not.toContain('one-install')
  expect(test.get().appUpdateBatch?.remotes[0]).toMatchObject({
    phase: 'failed',
    error: 'Pairing changed',
    pairingRevision: 1
  })
})

it('keeps legacy remotes visible for a separate update without sending unsupported pinned installs', async () => {
  const test = setup(['one'])
  const host = test.hosts.get('one')
  if (!host) {
    throw new Error('missing fixture host')
  }
  host.supportsPinned = false
  await test.get().discoverAppUpdateRemotes('1.6.0')
  expect(test.get().appUpdateCandidates[0]?.supportsPinnedInstall).toBe(false)
  await test.get().startAppUpdate()
  expect(test.events).not.toContain('one-install')
  expect(test.installLocal).toHaveBeenCalledOnce()
})
