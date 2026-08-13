/**
 * STA-3077 goalpost S4 — one durable partition per (target, pane).
 *
 * The reported failure: reconnecting an SSH host multiplied the user's
 * terminals, 2 -> 19 -> 20 across three reconnects. The mechanism was a pane
 * binding with two homes. Main's spawn wrote `ssh:<targetId>`, the relay's
 * reattach write passed no hostId and landed in `local`, and the renderer has
 * always published SSH pane membership to `local`. Supersession read the
 * partition no live writer maintained, saw the arriving lease disagree with a
 * stale pty id, and bailed — so it silently no-opped and every reconnect left
 * another live lease behind, with a shell and a pane to match.
 *
 * The mutation that must redden this file: in `src/main/ipc/pty.ts`, restore
 * the ssh-first-then-local hedge in `durablyBoundPtyIdForPane` and give the
 * spawn upserts their `ssh:<targetId>` hostId back. The divergent copy then
 * reappears, supersession stops firing, and `distinctBoundPtyIdsByLeaf` /
 * `liveLeasesByLeaf` grow past one per pane.
 *
 * Why this spec exists beside ssh-reconnect-pane-cardinality.spec.ts: that file
 * faults the transport with a kill, which reconnects with every lease still
 * marked attached. The user reported *reconnecting the host*, which is a clean
 * disconnect followed by a connect. Only the detach path moves a lease
 * attached -> detached and runs supersession on the way back, so this is the
 * shape the defect actually lived on, and it is the shape driven here — three
 * times, because the report counted three reconnects.
 *
 * Every clause is an observable: panes the user can see, leases on disk,
 * bindings in the durable session, and shells counted on the container itself.
 */
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  sendToTerminal,
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot,
  type PaneIdentitySnapshot
} from './helpers/terminal'
import { readDurablePaneBindings, sshExecutionHostId } from './helpers/remote-pane-durable-session'
import {
  describeSshRemotePtyLeases,
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
import {
  countDockerSshRelayRemoteStreamWriters,
  describeDockerSshRelayRemotePtys,
  readDockerSshRelayRemotePtys
} from './helpers/docker-ssh-relay-remote-ptys'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const PANE_COUNT = 2
// The reported repro shape: 2 -> 19 -> 20 was counted over three reconnects.
const RECONNECT_CYCLES = 3
// Why: the relay must outlive every reconnect. If it exits with the client the
// remote shells die too and reconnect degrades to a cold spawn, which is not
// the path this spec bounds.
const RELAY_GRACE_PERIOD_SECONDS = 900
// Why: a graft lands after reattach reports ready, so every dimension is
// re-read once the dust settles rather than the instant a wait passes.
const SETTLE_MS = 6_000

test.use({ seedTestRepo: false })

/** Leases that could still claim a shell. Terminated and expired ones cannot. */
function liveLeasesByLeaf(stateFile: string, targetId: string): Record<string, string[]> {
  const byLeaf: Record<string, string[]> = {}
  for (const lease of readSshRemotePtyLeases(stateFile, targetId)) {
    if (lease.state === 'terminated' || lease.state === 'expired') {
      continue
    }
    const leafId = lease.leafId ?? '<no-leaf>'
    byLeaf[leafId] = [...(byLeaf[leafId] ?? []), `${lease.ptyId}=${lease.state}`].sort()
  }
  return byLeaf
}

/**
 * `leafId -> the distinct pty ids any durable partition binds it to`.
 *
 * Two partitions naming the same leaf is tolerable while they agree; naming it
 * twice with different shells is the divergence supersession failed to resolve,
 * and it is what a user reads as a pane that came back doubled.
 */
async function distinctBoundPtyIdsByLeaf(
  page: Page,
  hostId: string,
  worktreeId: string
): Promise<Record<string, string[]>> {
  const byLeaf: Record<string, Set<string>> = {}
  for (const binding of await readDurablePaneBindings(page, hostId, worktreeId)) {
    // `<partition> <tabId>/<leafId>=<ptyId>`
    const [, pane] = binding.split(' ')
    const [paneKey, ptyId] = (pane ?? '').split('=')
    const leafId = (paneKey ?? '').split('/')[1]
    if (!leafId || !ptyId) {
      throw new Error(`Unparsable durable pane binding: ${binding}`)
    }
    byLeaf[leafId] = (byLeaf[leafId] ?? new Set<string>()).add(ptyId)
  }
  return Object.fromEntries(
    Object.entries(byLeaf).map(([leafId, ptyIds]) => [leafId, [...ptyIds].sort()])
  )
}

/** `tabId/leafId` for every pane the user can see in the workspace, plus its tabs. */
async function readRemotePaneCensus(
  page: Page,
  worktreeId: string
): Promise<{ tabIds: string[]; paneIds: string[] }> {
  return page.evaluate((worktreeId) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('Store unavailable')
    }
    type LayoutNode =
      | { type: 'leaf'; leafId: string }
      | { type: 'split'; first: LayoutNode; second: LayoutNode }
      | null
    const collectLeafIds = (node: LayoutNode): string[] =>
      !node
        ? []
        : node.type === 'leaf'
          ? [node.leafId]
          : [...collectLeafIds(node.first), ...collectLeafIds(node.second)]
    const tabs = state.tabsByWorktree[worktreeId] ?? []
    const paneIds = tabs.flatMap((tab) => {
      const leafIds = collectLeafIds(
        (state.terminalLayoutsByTabId[tab.id]?.root ?? null) as LayoutNode
      )
      // `root: null` is the implicit single-pane layout a fresh tab carries
      // until it is first split, so it still counts as one visible pane.
      return leafIds.length > 0
        ? leafIds.map((leafId) => `${tab.id}/${leafId}`)
        : [`${tab.id}/<root>`]
    })
    return { tabIds: tabs.map((tab) => tab.id).sort(), paneIds: paneIds.sort() }
  }, worktreeId)
}

async function waitForSshConnected(page: Page, targetId: string, timeoutMs: number): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          async (targetId) => (await window.api.ssh.getState({ targetId }))?.status ?? null,
          targetId
        ),
      { timeout: timeoutMs, message: 'SSH target never reported itself connected' }
    )
    .toBe('connected')
}

/**
 * A connected remote workspace with PANE_COUNT panes, each carrying a live
 * output source. Why every pane must stream: an idle pane reattaches as
 * 'existing' and never enters the source re-establishment the field failure
 * came through. The writer is backgrounded so the shell keeps its prompt.
 */
async function openStreamingRemotePanes(
  page: Page,
  target: DockerSshRelayTarget
): Promise<{
  remote: Awaited<ReturnType<typeof connectDockerSshRelayTarget>>
  snapshot: PaneIdentitySnapshot
}> {
  await waitForSessionReady(page)
  const remote = await connectDockerSshRelayTarget(page, target, {
    relayGracePeriodSeconds: RELAY_GRACE_PERIOD_SECONDS
  })
  await expect.poll(() => waitForActiveWorktree(page), { timeout: 30_000 }).toBe(remote.worktreeId)
  await ensureTerminalVisible(page, 45_000)
  await waitForActiveTerminalManager(page, 60_000)
  await waitForActivePanePtyId(page, 60_000)

  await splitActiveTerminalPane(page, 'vertical')
  const snapshot = await waitForPaneIdentitySnapshot(page, PANE_COUNT)

  const streamMarker = `SSH_PARTITION_STREAM_${Date.now()}`
  for (const pane of snapshot.panes) {
    if (!pane.ptyId) {
      throw new Error(`Pane ${pane.leafId} has no PTY to stream from`)
    }
    await sendToTerminal(
      page,
      pane.ptyId,
      `node -e "setInterval(()=>process.stdout.write('${streamMarker}_'+Date.now()+'\\n'),100)" &\r`
    )
  }
  await expect
    .poll(() => countDockerSshRelayRemoteStreamWriters(target, streamMarker), {
      timeout: 60_000,
      message: 'remote panes did not start streaming before the first reconnect'
    })
    .toBe(PANE_COUNT)
  await expect
    .poll(() => readDockerSshRelayRemotePtys(target).length, {
      timeout: 60_000,
      message: 'remote shells did not settle at one per pane before the first reconnect'
    })
    .toBe(PANE_COUNT)
  return { remote, snapshot }
}

test.describe('SSH reconnect cardinality with one durable partition per pane', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH reconnect uses POSIX SSH tooling.')

  test('three reconnects add no pane, no live lease and no remote shell', async ({
    orcaPage,
    electronApp
  }, testInfo: TestInfo) => {
    test.setTimeout(600_000)
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      const relayTarget = target
      const { remote, snapshot } = await openStreamingRemotePanes(orcaPage, relayTarget)
      const hostId = sshExecutionHostId(remote.targetId)
      const stateFile = await resolveOrcaProfileStateFile(electronApp)
      const leafIds = snapshot.panes.map((pane) => pane.leafId)
      const paneKeys = leafIds.map((leafId) => `${snapshot.tabId}:${leafId}`)
      const shellIdentity = (shell: { paneKey: string | null; pid: number; startTicks: number }) =>
        `${shell.paneKey ?? '-'}=${shell.pid}@${shell.startTicks}`

      const baselinePanes = await readRemotePaneCensus(orcaPage, remote.worktreeId)
      expect(baselinePanes.paneIds).toHaveLength(PANE_COUNT)
      const baselineShells = readDockerSshRelayRemotePtys(relayTarget)
      // Ties every later clause to a real starting point: the whole spec is
      // vacuous if the panes never owned a shell in the first place.
      for (const paneKey of paneKeys) {
        expect(
          baselineShells.filter((shell) => shell.paneKey === paneKey),
          `pane ${paneKey} did not start out owning exactly one remote shell`
        ).toHaveLength(1)
      }
      const baselineBindings = await distinctBoundPtyIdsByLeaf(orcaPage, hostId, remote.worktreeId)
      for (const leafId of leafIds) {
        expect(
          baselineBindings[leafId] ?? [],
          `pane ${leafId} must start out durably bound to exactly one shell`
        ).toHaveLength(1)
      }
      testInfo.annotations.push({
        type: 'ssh-partition-cardinality-baseline',
        description: `${describeDockerSshRelayRemotePtys(baselineShells)} leases=${describeSshRemotePtyLeases(
          readSshRemotePtyLeases(stateFile, remote.targetId)
        )}`
      })

      /** Every dimension a duplicated pane binding moves, re-read from its owner. */
      const assertCardinalityHolds = async (label: string): Promise<void> => {
        const panes = await readRemotePaneCensus(orcaPage, remote.worktreeId)
        expect(panes.paneIds, `${label} changed the panes the user can see`).toEqual(
          baselinePanes.paneIds
        )
        expect(panes.tabIds, `${label} changed the workspace tabs`).toEqual(baselinePanes.tabIds)

        const leases = liveLeasesByLeaf(stateFile, remote.targetId)
        for (const leafId of leafIds) {
          expect(
            leases[leafId] ?? [],
            `${label} left more than one live lease naming pane ${snapshot.tabId}/${leafId}`
          ).toHaveLength(1)
        }
        expect(
          Object.keys(leases).sort(),
          `${label} left a live lease for a pane that does not exist`
        ).toEqual([...leafIds].sort())

        const shells = readDockerSshRelayRemotePtys(relayTarget)
        for (const paneKey of paneKeys) {
          expect(
            shells.filter((shell) => shell.paneKey === paneKey),
            `${label} left the host running more than one shell for pane ${paneKey}`
          ).toHaveLength(1)
        }
        expect(shells, `${label} changed the number of shells the host runs`).toHaveLength(
          PANE_COUNT
        )

        // The pane may legitimately be bound to a successor shell, but never to
        // two at once: that is the divergence a user reads as a doubled terminal.
        const bindings = await distinctBoundPtyIdsByLeaf(orcaPage, hostId, remote.worktreeId)
        for (const leafId of leafIds) {
          expect(
            bindings[leafId] ?? [],
            `${label} left pane ${leafId} durably bound to more than one shell`
          ).toHaveLength(1)
        }
        expect(
          Object.keys(bindings).sort(),
          `${label} durably bound a pane the user never opened`
        ).toEqual([...leafIds].sort())
      }

      for (let cycle = 1; cycle <= RECONNECT_CYCLES; cycle += 1) {
        await reconnectDockerSshRelayTarget(orcaPage, remote.targetId)
        await waitForSshConnected(orcaPage, remote.targetId, 180_000)
        await ensureTerminalVisible(orcaPage, 45_000)
        await waitForActiveTerminalManager(orcaPage, 60_000)
        await waitForActivePanePtyId(orcaPage, 60_000)

        // Poll first: a duplicate can land after reattach reports ready, and a
        // single read taken the instant the wait passes would miss it.
        await expect
          .poll(() => readDockerSshRelayRemotePtys(relayTarget).length, {
            timeout: 120_000,
            message: `reconnect ${cycle} changed the number of shells the host runs`
          })
          .toBe(PANE_COUNT)
        await assertCardinalityHolds(`reconnect ${cycle}`)

        // Poll returns on its first passing probe, so sit out the settle window
        // and re-read every dimension a late graft could still move. Attributing
        // it to the reconnect that caused it beats letting it leak into the next
        // cycle, where the count is already suspect.
        await orcaPage.waitForTimeout(SETTLE_MS)
        await assertCardinalityHolds(`reconnect ${cycle} after settling`)
        testInfo.annotations.push({
          type: `ssh-partition-cardinality-reconnect-${cycle}`,
          description: `${describeDockerSshRelayRemotePtys(
            readDockerSshRelayRemotePtys(relayTarget)
          )} leases=${describeSshRemotePtyLeases(readSshRemotePtyLeases(stateFile, remote.targetId))}`
        })
      }

      // Closing the loop on the report itself: after the third reconnect the
      // host runs exactly the shells it ran before the first one.
      expect(
        readDockerSshRelayRemotePtys(relayTarget).map(shellIdentity).sort(),
        `${RECONNECT_CYCLES} reconnects replaced or multiplied the remote shells`
      ).toEqual(baselineShells.map(shellIdentity).sort())
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})
