/**
 * Pane and remote-PTY cardinality across reconnects, against a real OpenSSH
 * container.
 *
 * Two tests, with different standing:
 *
 * 1. 'adds no panes and no remote PTYs across repeated reconnects' is a forward
 *    guard only. It passes with and without the STA-3077 fixes: a cleanly
 *    severed transport reconnects without producing the divergence that grafted
 *    panes in the field. It still earns its place by counting the shells the
 *    relay hosts, on the container, and pinning their PIDs.
 *
 * 2. 'leaves a lease whose durable pane is gone unbound…' discriminates. It
 *    seeds the divergence — a live lease and a live remote shell that no durable
 *    pane names — and fails on a tree without the fix, where reattach grafts the
 *    pane back through persistPtyBinding's creating branches. The graft lands in
 *    the 'local' partition, because the reattach call site passes no hostId, so
 *    the census reads both partitions; one alone passes on either tree.
 */
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { randomUUID } from 'node:crypto'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  sendToTerminal,
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'
import { readDurablePaneBindings, sshExecutionHostId } from './helpers/remote-pane-durable-session'
import { seedUnboundRemotePtyLease } from './helpers/unbound-remote-pty-lease'
import {
  describeSshRemotePtyLeases,
  findSshRemotePtyLeaseForLeaf,
  readSshRemotePtyLeases,
  resolveOrcaProfileStateFile
} from './helpers/ssh-remote-pty-lease-file'
import {
  cleanupDockerSshRelayTarget,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import {
  connectDockerSshRelayTarget,
  reconnectDockerSshRelayTarget
} from './helpers/docker-ssh-relay-connection'
import { severDockerSshRelayTransport } from './helpers/docker-ssh-relay-processes'
import {
  countDockerSshRelayRemoteStreamWriters,
  describeDockerSshRelayRemotePtys,
  readDockerSshRelayRemotePtys
} from './helpers/docker-ssh-relay-remote-ptys'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const PANE_COUNT = 2
const RECONNECT_CYCLES = 3
// Why: the relay must outlive every fault. If it exits with the client the
// remote shells die too, reconnect degrades to a cold spawn, and the reattach
// path this spec exists to bound is never entered.
const RELAY_GRACE_PERIOD_SECONDS = 900
// Why: a graft lands after reattach reports ready, so the census has to be
// re-read once the dust settles rather than the instant the wait passes.
const SETTLE_MS = 6_000

test.use({ seedTestRepo: false })

async function waitForSshReconnected(page: Page, targetId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          async (targetId) => (await window.api.ssh.getState({ targetId }))?.status ?? null,
          targetId
        ),
      {
        timeout: 120_000,
        message: 'SSH target did not reconnect after its transport was severed'
      }
    )
    .toBe('connected')
}

/** Every terminal pane the user can see in a workspace, keyed tab/leaf. */
type RemotePaneCensus = {
  tabIds: string[]
  paneIds: string[]
}

async function readRemotePaneCensus(page: Page, worktreeId: string): Promise<RemotePaneCensus> {
  return page.evaluate((worktreeId) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('Store unavailable')
    }
    type LayoutNode =
      | { type: 'leaf'; leafId: string }
      | { type: 'split'; first: LayoutNode; second: LayoutNode }
      | null
    const collectLeafIds = (node: LayoutNode): string[] => {
      if (!node) {
        return []
      }
      return node.type === 'leaf'
        ? [node.leafId]
        : [...collectLeafIds(node.first), ...collectLeafIds(node.second)]
    }
    const tabs = state.tabsByWorktree[worktreeId] ?? []
    const paneIds = tabs.flatMap((tab) => {
      const leafIds = collectLeafIds(
        (state.terminalLayoutsByTabId[tab.id]?.root ?? null) as LayoutNode
      )
      // Why: `root: null` is the implicit single-pane layout a fresh tab carries
      // until it is first split, so it still counts as one visible pane.
      return leafIds.length > 0
        ? leafIds.map((leafId) => `${tab.id}/${leafId}`)
        : [`${tab.id}/<root>`]
    })
    return { tabIds: tabs.map((tab) => tab.id), paneIds: paneIds.sort() }
  }, worktreeId)
}

type StreamingRemoteWorkspace = {
  remote: Awaited<ReturnType<typeof connectDockerSshRelayTarget>>
  paneSnapshot: Awaited<ReturnType<typeof waitForPaneIdentitySnapshot>>
  baselinePanes: RemotePaneCensus
  baselineRemotePtys: ReturnType<typeof readDockerSshRelayRemotePtys>
}

/** A connected remote workspace with PANE_COUNT panes, each streaming output. */
async function openStreamingRemotePanes(
  page: Page,
  relayTarget: DockerSshRelayTarget
): Promise<StreamingRemoteWorkspace> {
  await waitForSessionReady(page)
  const remote = await connectDockerSshRelayTarget(page, relayTarget, {
    relayGracePeriodSeconds: RELAY_GRACE_PERIOD_SECONDS
  })
  await expect.poll(() => waitForActiveWorktree(page), { timeout: 30_000 }).toBe(remote.worktreeId)
  await ensureTerminalVisible(page, 45_000)
  await waitForActiveTerminalManager(page, 60_000)
  await waitForActivePanePtyId(page, 60_000)

  await splitActiveTerminalPane(page, 'vertical')
  const paneSnapshot = await waitForPaneIdentitySnapshot(page, PANE_COUNT)
  const baselinePanes = await readRemotePaneCensus(page, remote.worktreeId)
  expect(baselinePanes.paneIds).toHaveLength(PANE_COUNT)

  // Why every pane must be streaming: an idle pane carries no output source,
  // so its reattach sends no recovery checkpoint and the relay answers
  // 'existing'. Only a live source can come back needing re-establishment,
  // which is the outcome that used to read as expiry and respawn the shell.
  const streamMarker = `SSH_RECONNECT_STREAM_${Date.now()}`
  for (const pane of paneSnapshot.panes) {
    if (!pane.ptyId) {
      throw new Error(`Pane ${pane.leafId} has no PTY to stream from`)
    }
    await sendToTerminal(
      page,
      pane.ptyId,
      `node -e "setInterval(()=>process.stdout.write('${streamMarker}_'+Date.now()+'\\n'),25)"\r`
    )
  }
  await expect
    .poll(() => countDockerSshRelayRemoteStreamWriters(relayTarget, streamMarker), {
      timeout: 60_000,
      message: 'remote panes did not start streaming before the first transport fault'
    })
    .toBe(PANE_COUNT)

  // The remote census is the reporter's oracle: shells the relay hosts right
  // now, counted on the container rather than inferred from app state.
  await expect
    .poll(() => readDockerSshRelayRemotePtys(relayTarget).length, {
      timeout: 60_000,
      message: 'remote shells did not settle at one per pane before the first reconnect'
    })
    .toBe(PANE_COUNT)
  return {
    remote,
    paneSnapshot,
    baselinePanes,
    baselineRemotePtys: readDockerSshRelayRemotePtys(relayTarget)
  }
}

// STA-3077: reconnecting an SSH-backed workspace must be cardinality-neutral.
// The report had relay PTYs go 2 -> 19 -> 20 over three reconnects while panes
// the user never opened appeared alongside them, so both counts are asserted
// against the same fixed workspace after every cycle.
test.describe('SSH reconnect pane and remote PTY cardinality', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH reconnect uses POSIX SSH tooling.')

  test('adds no panes and no remote PTYs across repeated reconnects', async ({
    orcaPage
  }, testInfo: TestInfo) => {
    test.setTimeout(480_000)
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      const relayTarget = target
      const { remote, baselinePanes, baselineRemotePtys } = await openStreamingRemotePanes(
        orcaPage,
        relayTarget
      )
      const baselinePids = baselineRemotePtys.map((pty) => pty.pid)
      testInfo.annotations.push({
        type: 'ssh-reconnect-cardinality-baseline',
        description: describeDockerSshRelayRemotePtys(baselineRemotePtys)
      })

      for (let cycle = 1; cycle <= RECONNECT_CYCLES; cycle += 1) {
        severDockerSshRelayTransport(relayTarget)
        await waitForSshReconnected(orcaPage, remote.targetId)
        await ensureTerminalVisible(orcaPage, 45_000)
        await waitForActiveTerminalManager(orcaPage, 60_000)
        await waitForActivePanePtyId(orcaPage, 60_000)

        // Poll rather than sample once: a leaked pane or a duplicate shell can
        // land after reattach reports ready, and a single read would miss it.
        await expect
          .poll(() => readDockerSshRelayRemotePtys(relayTarget).map((pty) => pty.pid), {
            timeout: 90_000,
            message: `reconnect ${cycle} changed the live remote shells`
          })
          .toEqual(baselinePids)
        await expect
          .poll(async () => (await readRemotePaneCensus(orcaPage, remote.worktreeId)).paneIds, {
            timeout: 30_000,
            message: `reconnect ${cycle} changed the visible terminal panes`
          })
          .toEqual(baselinePanes.paneIds)
        expect(
          (await readRemotePaneCensus(orcaPage, remote.worktreeId)).tabIds,
          `reconnect ${cycle} changed the workspace tabs`
        ).toEqual(baselinePanes.tabIds)

        // Why not poll here: poll returns on its first passing probe, so
        // re-polling a value that already matched waits 0ms and observes
        // nothing. Sit out the settle window, then re-read every dimension a
        // late graft could move, so it is attributed to the reconnect that
        // caused it instead of leaking into the next cycle.
        await orcaPage.waitForTimeout(SETTLE_MS)
        const settled = await readRemotePaneCensus(orcaPage, remote.worktreeId)
        expect(
          readDockerSshRelayRemotePtys(relayTarget).map((pty) => pty.pid),
          `reconnect ${cycle} changed the remote shells after settling`
        ).toEqual(baselinePids)
        expect(
          settled.paneIds,
          `reconnect ${cycle} changed the visible terminal panes after settling`
        ).toEqual(baselinePanes.paneIds)
        expect(
          settled.tabIds,
          `reconnect ${cycle} changed the workspace tabs after settling`
        ).toEqual(baselinePanes.tabIds)
      }

      testInfo.annotations.push({
        type: 'ssh-reconnect-cardinality-final',
        description: `${RECONNECT_CYCLES} reconnects: ${describeDockerSshRelayRemotePtys(
          readDockerSshRelayRemotePtys(relayTarget)
        )}`
      })
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })

  // The divergence the field hit: a live lease and a live remote shell that no
  // durable pane names. Reconnect must reattach without inventing the pane back,
  // and without killing the shell it can no longer place.
  //
  // The precondition is seeded, not induced. Inducing it by closing a pane over
  // a severed transport is a race the induction loses: once the sever tears the
  // SSH providers down, `pty:kill` takes its tombstone branch and terminates the
  // lease, reattach never fans out over it, and every oracle downstream passes
  // vacuously on both trees. See helpers/unbound-remote-pty-lease.ts.
  //
  // Why an explicit disconnect/reconnect rather than a transport sever: only the
  // detach path moves the lease attached -> detached, which makes the flip back
  // to attached positive proof that reattach reached this exact lease. A severed
  // link reconnects with the lease still marked attached, so nothing on disk
  // separates "reattached and refused to bind" from "never visited".
  test('leaves a lease whose durable pane is gone unbound instead of grafting the pane back', async ({
    orcaPage,
    electronApp
  }, testInfo: TestInfo) => {
    test.setTimeout(480_000)
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      const relayTarget = target
      const { remote, paneSnapshot } = await openStreamingRemotePanes(orcaPage, relayTarget)
      const hostId = sshExecutionHostId(remote.targetId)
      const stateFile = await resolveOrcaProfileStateFile(electronApp)
      const readBindings = (): Promise<string[]> =>
        readDurablePaneBindings(orcaPage, hostId, remote.worktreeId)
      const livePids = (): number[] =>
        readDockerSshRelayRemotePtys(relayTarget)
          .map((pty) => pty.pid)
          .sort((left, right) => left - right)

      const unbound = await seedUnboundRemotePtyLease(orcaPage, {
        targetId: remote.targetId,
        hostId,
        worktreeId: remote.worktreeId,
        tabId: paneSnapshot.tabId,
        leafId: randomUUID()
      })
      // A live source, like the panes: an idle PTY reattaches as 'existing' and
      // never enters the source re-establishment the field failure came through.
      const unboundMarker = `SSH_UNBOUND_STREAM_${Date.now()}`
      await sendToTerminal(
        orcaPage,
        unbound.ptyId,
        `node -e "setInterval(()=>process.stdout.write('${unboundMarker}_'+Date.now()+'\\n'),100)"\r`
      )
      await expect
        .poll(() => countDockerSshRelayRemoteStreamWriters(relayTarget, unboundMarker), {
          timeout: 60_000,
          message: 'the unbound remote PTY never started streaming'
        })
        .toBe(1)
      await expect
        .poll(() => readDockerSshRelayRemotePtys(relayTarget).length, {
          timeout: 60_000,
          message: 'the relay did not settle at one shell per pane plus the unbound one'
        })
        .toBe(PANE_COUNT + 1)
      const seededPtys = readDockerSshRelayRemotePtys(relayTarget)
      const seededPids = seededPtys.map((pty) => pty.pid).sort((left, right) => left - right)
      // The seeded shell is the pane-key-less one: ORCA_PANE_KEY is injected by
      // the pane launch path, which a leaf that never becomes a pane never runs.
      for (const pane of paneSnapshot.panes) {
        expect(
          seededPtys.map((pty) => pty.paneKey),
          `pane ${pane.leafId} lost the remote shell it owns`
        ).toContain(`${paneSnapshot.tabId}:${pane.leafId}`)
      }
      expect(
        seededPtys.filter((pty) => pty.paneKey === null),
        'the seeded remote shell is not separable from the pane-owned ones'
      ).toHaveLength(1)
      testInfo.annotations.push({
        type: 'ssh-reconnect-unbound-lease-seeded',
        description: describeDockerSshRelayRemotePtys(seededPtys)
      })

      const seededLease = findSshRemotePtyLeaseForLeaf(stateFile, remote.targetId, unbound.leafId)
      expect(seededLease?.state, 'the seeded remote PTY never took a live lease').toBe('attached')
      const attachedBeforeReconnect = seededLease?.lastAttachedAt ?? 0
      const bindingsBeforeReconnect = await readBindings()
      expect(
        bindingsBeforeReconnect.filter((binding) => binding.includes(unbound.leafId)),
        'no durable partition may name the unbound leaf before the reconnect'
      ).toHaveLength(0)
      for (const pane of paneSnapshot.panes) {
        expect(
          bindingsBeforeReconnect.filter((binding) => binding.includes(pane.leafId)),
          `pane ${pane.leafId} must start out durably bound`
        ).not.toHaveLength(0)
      }

      await reconnectDockerSshRelayTarget(orcaPage, remote.targetId)
      await waitForSshReconnected(orcaPage, remote.targetId)
      await ensureTerminalVisible(orcaPage, 45_000)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      await waitForActivePanePtyId(orcaPage, 60_000)

      // Vacuity guard. Detach marked this lease 'detached'; only reattachKnownPtys
      // marks it 'attached' again, and only after visiting it. Without this, a
      // reattach that silently skipped the lease would be indistinguishable from
      // one that correctly refused to bind it, and the census below would prove
      // nothing.
      await expect
        .poll(
          () =>
            findSshRemotePtyLeaseForLeaf(stateFile, remote.targetId, unbound.leafId)
              ?.lastAttachedAt ?? 0,
          {
            timeout: 120_000,
            message:
              'reconnect never reattached the unbound lease, so the pane census below is vacuous'
          }
        )
        .toBeGreaterThan(attachedBeforeReconnect)
      testInfo.annotations.push({
        type: 'ssh-reconnect-unbound-lease-reattached',
        description: describeSshRemotePtyLeases(readSshRemotePtyLeases(stateFile, remote.targetId))
      })

      // Sample continuously rather than poll-until-equal: a graft that lands and
      // is later overwritten by a renderer snapshot would satisfy a poll that
      // only needs one matching read, and the defect would pass unnoticed.
      const deadline = Date.now() + 25_000
      let samples = 0
      while (Date.now() < deadline) {
        expect(
          await readBindings(),
          'reconnect grafted a durable pane for a lease no pane owns'
        ).toEqual(bindingsBeforeReconnect)
        samples += 1
        await orcaPage.waitForTimeout(500)
      }
      expect(samples).toBeGreaterThan(10)

      // Unknown is not dead: the unbound shell keeps running, so a later reattach
      // can still claim it once a durable pane names it again.
      expect(livePids(), 'the unbound remote shell was killed or respawned').toEqual(seededPids)
      expect(
        (await readRemotePaneCensus(orcaPage, remote.worktreeId)).paneIds,
        'reconnect surfaced a pane the user never opened'
      ).toHaveLength(PANE_COUNT)
      testInfo.annotations.push({
        type: 'ssh-reconnect-unbound-lease-final',
        description: describeDockerSshRelayRemotePtys(readDockerSshRelayRemotePtys(relayTarget))
      })
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})
