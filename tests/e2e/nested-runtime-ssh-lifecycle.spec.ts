import { expect, test } from './helpers/orca-app'
import {
  cleanupDockerSshRelayTarget,
  dockerSshRelayRepoSentinel,
  execDockerSshRelayTargetCommand,
  startDockerSshRelayTarget,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import {
  connectDockerSshRelayTarget,
  reconnectDisconnectedDockerSshRelayTarget
} from './helpers/docker-ssh-relay-connection'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  rePairPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { createRestartSession } from './helpers/orca-restart'
import {
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText,
  TerminalStreamOpcode
} from '../../src/shared/terminal-stream-protocol'
import {
  addPairedRuntimeEnvironment,
  assertInteractiveTerminal,
  assertNestedFilesystemRoute,
  assertNestedTerminalDestination
} from './helpers/nested-runtime-ssh-client-route'

const isDockerNestedRuntimeRun =
  process.env.ORCA_E2E_NESTED_RUNTIME_SSH === '1' && process.env.ORCA_E2E_WEB_CLIENT === '1'

test.skip(
  !isDockerNestedRuntimeRun,
  'Run with ORCA_E2E_NESTED_RUNTIME_SSH=1 and ORCA_E2E_WEB_CLIENT=1'
)

test.describe.configure({ mode: 'serial' })

async function assertRuntimeSshConnected(
  client: PairedElectronClient,
  targetId: string
): Promise<void> {
  await expect
    .poll(
      () =>
        client.page.evaluate(
          ({ environmentId, targetId }) =>
            window.__store
              ?.getState()
              .sshStateByEnvironment.get(environmentId)
              ?.connectionStates.get(targetId)?.status ?? null,
          { environmentId: client.environmentId, targetId }
        ),
      { timeout: 30_000 }
    )
    .toBe('connected')
}

function remoteTerminalHandle(ptyId: string): string {
  const separator = ptyId.indexOf('@@')
  if (!ptyId.startsWith('remote:') || separator === -1) {
    throw new Error(`Expected runtime-owned PTY id, received ${ptyId}`)
  }
  return decodeURIComponent(ptyId.slice(separator + 2))
}

function terminalMultiplexFrame(
  opcode: TerminalStreamOpcode,
  streamId: number,
  payload: Uint8Array<ArrayBufferLike>
): number[] {
  return Array.from(
    encodeTerminalStreamFrame({
      opcode,
      streamId,
      seq: 1,
      payload
    })
  )
}

async function waitForRemoteTerminalMarker(
  client: PairedElectronClient,
  ptyId: string,
  marker: string
): Promise<void> {
  const terminal = remoteTerminalHandle(ptyId)
  await expect
    .poll(
      () =>
        client.page.evaluate(
          async ({ environmentId, terminal }) => {
            const response = await window.api.runtimeEnvironments.call({
              selector: environmentId,
              method: 'terminal.read',
              params: { terminal, limit: 1_000 }
            })
            return JSON.stringify(response)
          },
          { environmentId: client.environmentId, terminal }
        ),
      { timeout: 30_000 }
    )
    .toContain(marker)
}

async function readRemoteShellPid(
  client: PairedElectronClient,
  ptyId: string,
  marker: string
): Promise<string> {
  const terminal = remoteTerminalHandle(ptyId)
  const send = await client.page.evaluate(
    ({ environmentId, marker, terminal }) =>
      window.api.runtimeEnvironments.call({
        selector: environmentId,
        method: 'terminal.send',
        params: {
          terminal,
          text: `printf '${marker}%s\\n' "$$"\n`,
          client: { id: 'nested-shell-identity', type: 'desktop' }
        }
      }),
    { environmentId: client.environmentId, marker, terminal }
  )
  if (!send.ok) {
    throw new Error(`terminal.send failed: ${JSON.stringify(send)}`)
  }
  let pid = ''
  await expect
    .poll(
      async () => {
        pid = await client.page.evaluate(
          async ({ environmentId, marker, terminal }) => {
            const read = await window.api.runtimeEnvironments.call({
              selector: environmentId,
              method: 'terminal.read',
              params: { terminal, limit: 500 }
            })
            const match = JSON.stringify(read).match(new RegExp(`${marker}(\\d+)`))
            return match?.[1] ?? ''
          },
          { environmentId: client.environmentId, marker, terminal }
        )
        return pid
      },
      { timeout: 30_000 }
    )
    .not.toBe('')
  return pid
}

test('isolates nested SSH worktrees across two HUB runtimes', async ({
  orcaAppExtraEnv: _orcaAppExtraEnv
}, testInfo) => {
  test.setTimeout(720_000)
  const hubA = createRestartSession(testInfo)
  const hubB = createRestartSession(testInfo)
  let targetA: DockerSshRelayTarget | null = null
  let targetB: DockerSshRelayTarget | null = null
  let client: PairedElectronClient | null = null
  let hubALaunch: Awaited<ReturnType<typeof hubA.launch>> | null = null
  let hubBLaunch: Awaited<ReturnType<typeof hubB.launch>> | null = null
  try {
    targetA = startDockerSshRelayTarget(testInfo)
    targetB = startDockerSshRelayTarget(testInfo)
    hubALaunch = await hubA.launch()
    hubBLaunch = await hubB.launch()
    await Promise.all(
      [hubALaunch.page, hubBLaunch.page].map((page) =>
        page.waitForFunction(
          () => window.__store?.getState().workspaceSessionReady === true,
          null,
          {
            timeout: 30_000
          }
        )
      )
    )
    const remoteA = await connectDockerSshRelayTarget(hubALaunch.page, targetA)
    const remoteB = await connectDockerSshRelayTarget(hubBLaunch.page, targetB)
    const offerA = await createRuntimeDesktopPairingOffer(hubALaunch.page)
    client = await launchPairedElectronClient(offerA, testInfo, 'Nested SSH multi-HUB A')
    const environmentA = client.environmentId
    const routeA = await assertInteractiveTerminal(
      client,
      remoteA.repoId,
      `MULTI_HUB_A_${Date.now()}`
    )
    expect(routeA.runtimeOwnerEnvironmentId).toBe(environmentA)
    expect(routeA.localSshTargetIds).not.toContain(remoteA.targetId)
    await assertNestedTerminalDestination(
      client,
      dockerSshRelayRepoSentinel(targetA, DOCKER_SSH_RELAY_REMOTE_REPO_PATH)
    )

    const offerB = await createRuntimeDesktopPairingOffer(hubBLaunch.page)
    const environmentB = await addPairedRuntimeEnvironment(client, offerB, 'Nested SSH multi-HUB B')
    expect(environmentB).not.toBe(environmentA)
    const routeB = await assertInteractiveTerminal(
      client,
      remoteB.repoId,
      `MULTI_HUB_B_${Date.now()}`
    )
    expect(routeB.runtimeOwnerEnvironmentId).toBe(environmentB)
    expect(routeB.worktreePath).toBe(routeA.worktreePath)
    expect(routeB.ptyId).toContain(encodeURIComponent(environmentB))
    expect(routeB.localSshTargetIds).toEqual([])
    await assertNestedTerminalDestination(
      client,
      dockerSshRelayRepoSentinel(targetB, DOCKER_SSH_RELAY_REMOTE_REPO_PATH)
    )
    await assertNestedFilesystemRoute(client, routeB, {
      onRenamed: (absolutePath) => {
        expect(
          execDockerSshRelayTargetCommand(targetB!, `[ -f '${absolutePath}' ] && echo yes`)
        ).toBe('yes')
        expect(
          execDockerSshRelayTargetCommand(targetA!, `[ ! -e '${absolutePath}' ] && echo yes`)
        ).toBe('yes')
      }
    })

    const routeAWhileBFocused = await assertInteractiveTerminal(
      client,
      remoteA.repoId,
      `MULTI_HUB_A_WITH_B_FOCUSED_${Date.now()}`
    )
    expect(routeAWhileBFocused.runtimeOwnerEnvironmentId).toBe(environmentA)
    expect(routeAWhileBFocused.ptyId).toContain(encodeURIComponent(environmentA))
    expect(routeAWhileBFocused.ptyId).not.toContain(encodeURIComponent(environmentB))
    await assertNestedTerminalDestination(
      client,
      dockerSshRelayRepoSentinel(targetA, DOCKER_SSH_RELAY_REMOTE_REPO_PATH)
    )
    await assertNestedFilesystemRoute(client, routeAWhileBFocused, {
      onRenamed: (absolutePath) => {
        expect(
          execDockerSshRelayTargetCommand(targetA!, `[ -f '${absolutePath}' ] && echo yes`)
        ).toBe('yes')
        expect(
          execDockerSshRelayTargetCommand(targetB!, `[ ! -e '${absolutePath}' ] && echo yes`)
        ).toBe('yes')
      }
    })

    await client.page.evaluate((environmentId) => {
      const store = window.__store
      if (!store) {
        throw new Error('Paired desktop store is unavailable')
      }
      const originalFetch = store.getState().fetchRuntimeEnvironmentRepos
      let releaseRefresh: (() => void) | null = null
      const probe = {
        environmentId,
        finished: false,
        release: () => releaseRefresh?.(),
        started: false
      }
      Object.assign(globalThis, { __nestedRuntimeStalePublicationProbe: probe })
      store.setState({
        // Why: hold a publication already received from HUB A across removal so the stale callback cannot pass vacuously.
        fetchRuntimeEnvironmentRepos: async (requestedEnvironmentId: string) => {
          if (requestedEnvironmentId === environmentId && !probe.started) {
            probe.started = true
            await new Promise<void>((resolve) => {
              releaseRefresh = resolve
              probe.release = resolve
            })
          }
          try {
            return await originalFetch(requestedEnvironmentId)
          } finally {
            if (requestedEnvironmentId === environmentId) {
              probe.finished = true
            }
          }
        }
      })
    }, environmentA)
    const publishedUpdate = await client.page.evaluate(
      ({ environmentId, repoId }) =>
        window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'repo.update',
          params: {
            repo: repoId,
            updates: { displayName: `Stale publication ${Date.now()}` }
          }
        }),
      { environmentId: environmentA, repoId: remoteA.repoId }
    )
    expect(publishedUpdate.ok).toBe(true)
    await expect
      .poll(() =>
        client!.page.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                __nestedRuntimeStalePublicationProbe?: { started: boolean }
              }
            ).__nestedRuntimeStalePublicationProbe?.started ?? false
        )
      )
      .toBe(true)
    await client.page.evaluate(async (environmentId) => {
      const store = window.__store
      if (!store) {
        throw new Error('Paired desktop store is unavailable')
      }
      await window.api.runtimeEnvironments.remove({ selector: environmentId })
      store.getState().setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
      const probeScope = globalThis as typeof globalThis & {
        __nestedRuntimeStalePublicationProbe?: { release: () => void }
      }
      probeScope.__nestedRuntimeStalePublicationProbe?.release()
    }, environmentA)
    await expect
      .poll(() =>
        client!.page.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                __nestedRuntimeStalePublicationProbe?: { finished: boolean }
              }
            ).__nestedRuntimeStalePublicationProbe?.finished ?? false
        )
      )
      .toBe(true)
    await expect
      .poll(() =>
        client!.page.evaluate((environmentId) => {
          const state = window.__store?.getState()
          return Object.values(state?.worktreesByRepo ?? {})
            .flat()
            .some((worktree) => worktree.runtimeOwnerEnvironmentId === environmentId)
        }, environmentA)
      )
      .toBe(false)
    const routeBAfterStalePublication = await assertInteractiveTerminal(
      client,
      remoteB.repoId,
      `MULTI_HUB_B_AFTER_STALE_A_${Date.now()}`
    )
    expect(routeBAfterStalePublication.runtimeOwnerEnvironmentId).toBe(environmentB)
    expect(routeBAfterStalePublication.ptyId).toContain(encodeURIComponent(environmentB))
    expect(await client.getDirectSshAttemptTargetIds()).toEqual([])
  } finally {
    await client?.dispose()
    if (hubBLaunch) {
      await hubB.close(hubBLaunch.app)
    }
    if (hubALaunch) {
      await hubA.close(hubALaunch.app)
    }
    await hubB.dispose()
    await hubA.dispose()
    cleanupDockerSshRelayTarget(targetB)
    cleanupDockerSshRelayTarget(targetA)
  }
})

test('routes nested SSH through a HUB without shared-control capability', async ({
  orcaAppExtraEnv: _orcaAppExtraEnv
}, testInfo) => {
  test.setTimeout(360_000)
  const hub = createRestartSession(testInfo, {
    ORCA_E2E_DISABLE_RUNTIME_SHARED_CONTROL: '1'
  })
  let target: DockerSshRelayTarget | null = null
  let client: PairedElectronClient | null = null
  let hubLaunch: Awaited<ReturnType<typeof hub.launch>> | null = null
  try {
    target = startDockerSshRelayTarget(testInfo)
    hubLaunch = await hub.launch()
    await hubLaunch.page.waitForFunction(
      () => window.__store?.getState().workspaceSessionReady === true,
      null,
      { timeout: 30_000 }
    )
    const remote = await connectDockerSshRelayTarget(hubLaunch.page, target)
    const offer = await createRuntimeDesktopPairingOffer(hubLaunch.page)
    client = await launchPairedElectronClient(offer, testInfo, 'Nested SSH legacy transport HUB')
    const status = await client.page.evaluate(async (environmentId) => {
      const response = await window.api.runtimeEnvironments.call({
        selector: environmentId,
        method: 'status.get'
      })
      return response.ok
        ? ((response.result as { capabilities?: string[] }).capabilities ?? [])
        : []
    }, client.environmentId)
    expect(status).not.toContain('remote-runtime.shared-control.v1')

    const route = await assertInteractiveTerminal(
      client,
      remote.repoId,
      `LEGACY_TRANSPORT_NESTED_SSH_${Date.now()}`
    )
    await assertNestedTerminalDestination(
      client,
      dockerSshRelayRepoSentinel(target, DOCKER_SSH_RELAY_REMOTE_REPO_PATH)
    )
    await assertNestedFilesystemRoute(client, route)
    expect(await client.getDirectSshAttemptTargetIds()).toEqual([])
  } finally {
    await client?.dispose()
    if (hubLaunch) {
      await hub.close(hubLaunch.app)
    }
    await hub.dispose()
    cleanupDockerSshRelayTarget(target)
  }
})

test('quarantines an old terminal stream after same-ID HUB re-pair', async ({
  orcaAppExtraEnv: _orcaAppExtraEnv
}, testInfo) => {
  test.setTimeout(720_000)
  const hub = createRestartSession(testInfo)
  let target: DockerSshRelayTarget | null = null
  let client: PairedElectronClient | null = null
  let hubLaunch: Awaited<ReturnType<typeof hub.launch>> | null = null
  try {
    target = startDockerSshRelayTarget(testInfo)
    hubLaunch = await hub.launch()
    await hubLaunch.page.waitForFunction(
      () => window.__store?.getState().workspaceSessionReady === true,
      null,
      { timeout: 30_000 }
    )
    const remote = await connectDockerSshRelayTarget(hubLaunch.page, target)
    const offer = await createRuntimeDesktopPairingOffer(hubLaunch.page)
    client = await launchPairedElectronClient(offer, testInfo, 'Nested SSH same-ID HUB')
    const environmentId = client.environmentId
    const rendererToken = `same-id-renderer-${Date.now()}`
    await client.page.evaluate((token) => {
      Object.assign(globalThis, { __sameIdRendererToken: token })
    }, rendererToken)
    const before = await assertInteractiveTerminal(
      client,
      remote.repoId,
      `SAME_ID_BEFORE_${Date.now()}`
    )
    const terminal = remoteTerminalHandle(before.ptyId)
    const previousPairingRevision = await client.page.evaluate(async (selector) => {
      const environment = await window.api.runtimeEnvironments.resolve({ selector })
      return environment.pairingRevision ?? environment.createdAt
    }, environmentId)
    const streamId = 73
    const subscribeFrame = terminalMultiplexFrame(
      TerminalStreamOpcode.Subscribe,
      0,
      encodeTerminalStreamJson({
        streamId,
        terminal,
        client: { id: 'same-id-old-stream', type: 'desktop' },
        viewport: { cols: 100, rows: 30 }
      })
    )
    await client.page.evaluate(
      async ({ environmentId, previousPairingRevision, subscribeFrame }) => {
        const probe = {
          binaries: 0,
          closes: 0,
          errors: 0,
          responses: 0,
          subscription: null as null | {
            sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => void
            unsubscribe: () => void
          }
        }
        Object.assign(globalThis, { __sameIdMultiplexProbe: probe })
        probe.subscription = await window.api.runtimeEnvironments.subscribe(
          {
            selector: environmentId,
            method: 'terminal.multiplex',
            params: {},
            expectedEnvironmentPairingRevision: previousPairingRevision
          },
          {
            onResponse: () => {
              probe.responses += 1
            },
            onBinary: () => {
              probe.binaries += 1
            },
            onError: () => {
              probe.errors += 1
            },
            onClose: () => {
              probe.closes += 1
            }
          }
        )
        probe.subscription.sendBinary(new Uint8Array(subscribeFrame))
      },
      { environmentId, previousPairingRevision, subscribeFrame }
    )
    await expect
      .poll(() =>
        client!.page.evaluate(() => {
          const probe = (
            globalThis as typeof globalThis & {
              __sameIdMultiplexProbe?: { binaries: number; responses: number }
            }
          ).__sameIdMultiplexProbe
          return Boolean(probe && probe.responses > 0 && probe.binaries > 0)
        })
      )
      .toBe(true)

    const liveOldStreamMarker = `SAME_ID_OLD_STREAM_LIVE_${Date.now()}`
    const liveOldStreamInput = terminalMultiplexFrame(
      TerminalStreamOpcode.Input,
      streamId,
      encodeTerminalStreamText(`printf '${liveOldStreamMarker}\\n'\n`)
    )
    await client.page.evaluate((frame) => {
      const probe = (
        globalThis as typeof globalThis & {
          __sameIdMultiplexProbe?: {
            subscription: { sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => void } | null
          }
        }
      ).__sameIdMultiplexProbe
      probe?.subscription?.sendBinary(new Uint8Array(frame))
    }, liveOldStreamInput)
    await waitForRemoteTerminalMarker(client, before.ptyId, liveOldStreamMarker)

    const replacementOffer = await createRuntimeDesktopPairingOffer(hubLaunch.page)
    const replacement = await client.replacePairingInPlace(replacementOffer)
    expect(replacement.environmentId).toBe(environmentId)
    expect(replacement.previousPairingRevision).toBe(previousPairingRevision)
    expect(replacement.nextPairingRevision).toBeGreaterThan(previousPairingRevision)
    const oldTrafficAfterReplacement = await client.page.evaluate(() => {
      const probe = (
        globalThis as typeof globalThis & {
          __sameIdMultiplexProbe?: {
            binaries: number
            errors: number
            responses: number
          }
        }
      ).__sameIdMultiplexProbe
      return probe
        ? {
            binaries: probe.binaries,
            errors: probe.errors,
            responses: probe.responses
          }
        : null
    })
    expect(
      await client.page.evaluate(
        () =>
          (globalThis as typeof globalThis & { __sameIdRendererToken?: string })
            .__sameIdRendererToken
      )
    ).toBe(rendererToken)

    const staleCallCode = await client.page.evaluate(
      async ({ environmentId, previousPairingRevision }) => {
        const response = await window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'status.get',
          expectedEnvironmentPairingRevision: previousPairingRevision
        })
        return response.ok ? 'unexpected-success' : response.error.code
      },
      { environmentId, previousPairingRevision }
    )
    expect(staleCallCode).toBe('runtime_environment_changed')
    const staleSubscribeRejected = await client.page.evaluate(
      async ({ environmentId, previousPairingRevision }) => {
        try {
          await window.api.runtimeEnvironments.subscribe(
            {
              selector: environmentId,
              method: 'terminal.multiplex',
              params: {},
              expectedEnvironmentPairingRevision: previousPairingRevision
            },
            { onResponse: () => {} }
          )
          return false
        } catch (error) {
          return String(error).includes('pairing changed')
        }
      },
      { environmentId, previousPairingRevision }
    )
    expect(staleSubscribeRejected).toBe(true)

    const quarantinedMarker = `SAME_ID_OLD_STREAM_QUARANTINED_${Date.now()}`
    const staleInput = terminalMultiplexFrame(
      TerminalStreamOpcode.Input,
      streamId,
      encodeTerminalStreamText(`printf '${quarantinedMarker}\\n'\n`)
    )
    await client.page.evaluate((frame) => {
      const probe = (
        globalThis as typeof globalThis & {
          __sameIdMultiplexProbe?: {
            subscription: { sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => void } | null
          }
        }
      ).__sameIdMultiplexProbe
      probe?.subscription?.sendBinary(new Uint8Array(frame))
    }, staleInput)
    const after = await assertInteractiveTerminal(
      client,
      remote.repoId,
      `SAME_ID_AFTER_${Date.now()}`,
      { waitForReconnectReady: true }
    )
    expect(after.runtimeOwnerEnvironmentId).toBe(environmentId)
    expect(remoteTerminalHandle(after.ptyId)).toBe(terminal)
    expect(after.ptyId).toContain(encodeURIComponent(environmentId))
    const afterRead = await client.page.evaluate(
      async ({ environmentId, terminal }) => {
        return window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'terminal.read',
          params: { terminal, limit: 1_000 }
        })
      },
      { environmentId, terminal }
    )
    expect(JSON.stringify(afterRead)).not.toContain(quarantinedMarker)
    const oldTrafficAfterRecovery = await client.page.evaluate(() => {
      const probe = (
        globalThis as typeof globalThis & {
          __sameIdMultiplexProbe?: {
            binaries: number
            errors: number
            responses: number
            subscription: { unsubscribe: () => void } | null
          }
        }
      ).__sameIdMultiplexProbe
      const traffic = probe
        ? {
            binaries: probe.binaries,
            errors: probe.errors,
            responses: probe.responses
          }
        : null
      probe?.subscription?.unsubscribe()
      return traffic
    })
    expect(oldTrafficAfterRecovery).toEqual(oldTrafficAfterReplacement)
    expect(await client.getDirectSshAttemptTargetIds()).toEqual([])
  } finally {
    await client?.dispose()
    if (hubLaunch) {
      await hub.close(hubLaunch.app)
    }
    await hub.dispose()
    cleanupDockerSshRelayTarget(target)
  }
})

test('restores a paired nested SSH route after the HUB restarts', async ({
  orcaAppExtraEnv: _orcaAppExtraEnv
}, testInfo) => {
  test.setTimeout(720_000)
  const hub = createRestartSession(testInfo)
  let target: DockerSshRelayTarget | null = null
  let client: PairedElectronClient | null = null
  let hubLaunch: Awaited<ReturnType<typeof hub.launch>> | null = null
  try {
    target = startDockerSshRelayTarget(testInfo)
    hubLaunch = await hub.launch()
    await hubLaunch.page.waitForFunction(
      () => window.__store?.getState().workspaceSessionReady === true,
      null,
      { timeout: 30_000 }
    )
    const remote = await connectDockerSshRelayTarget(hubLaunch.page, target, {
      relayGracePeriodSeconds: 120
    })
    const offer = await createRuntimeDesktopPairingOffer(hubLaunch.page)
    client = await launchPairedElectronClient(offer, testInfo, 'Nested SSH restart HUB')
    const beforeRestart = await assertInteractiveTerminal(
      client,
      remote.repoId,
      `HUB_RESTART_BEFORE_${Date.now()}`
    )
    expect(beforeRestart.runtimeOwnerEnvironmentId).toBe(client.environmentId)
    const shellPidBeforeRestart = await readRemoteShellPid(
      client,
      beforeRestart.ptyId,
      'ORCA_SHELL_BEFORE_RESTART_'
    )
    const preRestartEnvironmentId = client.environmentId

    await hub.close(hubLaunch.app)
    await expect(
      client.page.evaluate((environmentId) => {
        const store = window.__store
        return store ? store.getState().refreshRuntimeEnvironmentStatus(environmentId) : false
      }, preRestartEnvironmentId)
    ).resolves.toBe(false)
    expect(await client.getDirectSshAttemptTargetIds()).toEqual([])
    hubLaunch = await hub.launch()
    await hubLaunch.page.waitForFunction(
      () => window.__store?.getState().workspaceSessionReady === true,
      null,
      { timeout: 30_000 }
    )
    const existingPairingRecovered = await client.page.evaluate(async (environmentId) => {
      const store = window.__store
      if (!store) {
        return false
      }
      if (!(await store.getState().refreshRuntimeEnvironmentStatus(environmentId))) {
        return false
      }
      return store.getState().switchRuntimeEnvironment(environmentId)
    }, preRestartEnvironmentId)
    expect(existingPairingRecovered).toBe(true)
    await reconnectDisconnectedDockerSshRelayTarget(hubLaunch.page, remote.targetId)
    await assertRuntimeSshConnected(client, remote.targetId)
    const afterRestartWithoutRepair = await assertInteractiveTerminal(
      client,
      remote.repoId,
      `HUB_RESTART_EXISTING_PAIR_${Date.now()}`,
      { waitForReconnectReady: true }
    )
    expect(afterRestartWithoutRepair.runtimeOwnerEnvironmentId).toBe(preRestartEnvironmentId)
    expect(
      await readRemoteShellPid(client, afterRestartWithoutRepair.ptyId, 'ORCA_SHELL_AFTER_RESTART_')
    ).toBe(shellPidBeforeRestart)

    const restartedOffer = await createRuntimeDesktopPairingOffer(hubLaunch.page)
    await rePairPairedElectronClient(client, restartedOffer, 'Nested SSH restarted HUB')
    await assertRuntimeSshConnected(client, remote.targetId)
    const afterRestart = await assertInteractiveTerminal(
      client,
      remote.repoId,
      `HUB_RESTART_AFTER_${Date.now()}`,
      { waitForReconnectReady: true }
    )
    expect(afterRestart.runtimeOwnerEnvironmentId).toBe(client.environmentId)
    expect(afterRestart.ptyId).toContain(encodeURIComponent(client.environmentId))
    expect(await client.getDirectSshAttemptTargetIds()).toEqual([])
  } finally {
    await client?.dispose()
    if (hubLaunch) {
      await hub.close(hubLaunch.app)
    }
    await hub.dispose()
    cleanupDockerSshRelayTarget(target)
  }
})
