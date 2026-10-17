import type { Page, TestInfo } from '@stablyai/playwright-test'
import type { AgentStatusEntry } from '../../src/shared/agent-status-types'
import { test, expect } from './helpers/orca-app'
import { readHookEndpoint } from './helpers/agent-hook-endpoint'
import type { NativeObservation, NativeRef } from './helpers/omp-native-observation'
import { startOmpStatusRuntime, type OmpStatusRuntime } from './helpers/omp-subagent-status-runtime'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  waitForActivePaneHookDescriptor,
  waitForActiveTerminalManager,
  type ActivePaneHookDescriptor
} from './helpers/terminal'
import { worktreeRow } from './worktree-row-locators'

// Real installed OMP task/wait/bash/registry/RPC; only model responses are local fixtures.
// ORCA_BACKGROUND_LAUNCH=1 ORCA_REAL_OMP_CLI_TEST=1 pnpm run test:e2e omp-subagent-status.spec.ts --workers=1
// Opt in to the same scenario at 8×6 with ORCA_OMP_SCALE=1, or 16×8 with ORCA_OMP_SCALE_STRESS=1.
// Optional ORCA_OMP_PROOF_BINARY=/absolute/path/to/omp; artifacts remain under test-results/.
const CHILD_NAMES = [
  'IndexAudit',
  'ArtifactCheck',
  'QuietWorker',
  'DocScan',
  'BuildCheck',
  'EdgeAudit',
  'OwnerCheck',
  'RootFence'
]
const QUIET_MS = 10_500 // Two real five-second authoritative refresh periods, without fake clocks.
const STABLE_FIELDS = [
  'state',
  'prompt',
  'toolName',
  'toolInput',
  'lastAssistantMessage',
  'stateStartedAt',
  'turnStartedAt',
  'stateHistory',
  'providerSession',
  'subagents'
] as const
declare global {
  var __ompIsolationCheck: (() => string | undefined) | undefined
}

test.skip(process.env.ORCA_REAL_OMP_CLI_TEST !== '1', 'Opt-in installed OMP native scenario')
test.use({ minimumSeededWorktreeCount: 1 })
test.beforeAll(() => {
  if (process.env.ORCA_BACKGROUND_LAUNCH !== '1' || process.env.ORCA_E2E_FORCE_HEADFUL === '1') {
    throw new Error('Native OMP E2E requires ORCA_BACKGROUND_LAUNCH=1 and the hidden renderer')
  }
})

type Root = ActivePaneHookDescriptor & {
  runtime: OmpStatusRuntime
  native: NativeObservation
  label: string
  remaining: string[]
}

function nativeRoot(runtime: OmpStatusRuntime): NativeObservation {
  const root = runtime.observations().findLast((row) => row.kind === 'root')
  if (!root?.sessionId || !root.ownerMatches) {
    throw new Error(`No exact native root-manager ownership: ${runtime.directory}`)
  }
  return root
}

function nativeChildren(root: Root): NativeRef[] {
  const snapshot = root.runtime
    .observations()
    .findLast((row) => row.kind === 'registry' && row.sessionId === root.native.sessionId)
  return (snapshot?.refs ?? []).filter(
    (ref) =>
      ref.kind === 'sub' &&
      ref.parentId === root.native.id &&
      ((ref.status === 'running' && ref.isStreaming === true) || ref.pendingAsync === true)
  )
}

function readStatuses(page: Page): Promise<Record<string, AgentStatusEntry>> {
  return page.evaluate(() => window.__store!.getState().agentStatusByPaneKey)
}

async function expectRosters(page: Page, roots: Root[]) {
  let statuses: Record<string, AgentStatusEntry> = {}
  await expect(async () => {
    statuses = await readStatuses(page)
    for (const root of roots) {
      const row = statuses[root.paneKey]
      const children = row?.subagents ?? []
      const refs = nativeChildren(root)
      expect(row).toMatchObject({
        state: 'working',
        prompt: root.label,
        toolName: 'wait',
        providerSession: { id: root.native.sessionId, transcriptPath: root.native.sessionFile }
      })
      expect(refs).toHaveLength(root.remaining.length)
      expect(root.remaining.every((name) => refs.some((ref) => ref.id.includes(name)))).toBe(true)
      expect(children.map((child) => child.id).sort()).toEqual(refs.map((ref) => ref.id).sort())
      for (const child of children) {
        expect(child).toMatchObject({
          state: 'working',
          startedAt: refs.find((ref) => ref.id === child.id)?.createdAt
        })
      }
      const paused = refs.find((ref) => ref.id.includes(CHILD_NAMES[2]!))
      expect(paused).toMatchObject({ status: 'idle', isStreaming: false, pendingAsync: true })
    }
  }).toPass({ timeout: 90_000 })
  return statuses
}

async function finishRoots(page: Page, roots: Root[], names: string[]) {
  const finishing = roots.map((root) => ({ root, refs: nativeChildren(root) }))
  await Promise.all(
    roots.map(async (root) => {
      await root.runtime.release('root-finish')
      await Promise.all(names.map((name) => root.runtime.release(name)))
    })
  )
  await expect(async () => {
    const statuses = await readStatuses(page)
    for (const { root, refs } of finishing) {
      const row = statuses[root.paneKey]
      expect(row?.state).toBe('done')
      expect(row?.subagents ?? []).toEqual([])
      expect(nativeChildren(root)).toEqual([])
      const facts = root.runtime.observations().filter((entry) => entry.at >= root.native.at)
      for (const ref of refs) {
        expect(facts).toContainEqual(
          expect.objectContaining({ kind: 'lifecycle', id: ref.id, status: 'completed' })
        )
      }
      expect(facts).toContainEqual(
        expect.objectContaining({ kind: 'async-model-resumed', name: CHILD_NAMES[2]! })
      )
    }
  }).toPass({ timeout: 30_000 })
}

async function expectCompact(page: Page, root: Root, info: TestInfo) {
  const surface = worktreeRow(page, root.worktreeId).locator('[data-compact-agent-list]')
  const summary = surface.locator('button.compact-agent-summary-button')
  if ((await summary.getAttribute('aria-expanded')) !== 'true') {
    await summary.click()
  }
  const rootRow = surface.locator('.agent-disclosure-row').filter({
    has: page.locator('span[title]').filter({ hasText: root.label })
  })
  const disclosure = rootRow.locator('[data-agent-child-disclosure-button]')
  if ((await disclosure.getAttribute('aria-expanded')) !== 'true') {
    await disclosure.click()
  }
  const child = nativeChildren(root)[0]!
  await expect(
    rootRow
      .locator('xpath=following-sibling::*[1]')
      .getByTitle(`${child.id} - status-smoke`, { exact: true })
  ).toBeVisible()
  // Crop account/host/project details without showing or focusing a BrowserWindow.
  const file = info.outputPath('native-compact.png')
  await surface.screenshot({ path: file, animations: 'disabled' })
  await info.attach('native-compact', { path: file, contentType: 'image/png' })
}

for (const workload of [
  { roots: 2, children: 3 },
  ...(process.env.ORCA_OMP_SCALE === '1' ? [{ roots: 8, children: 6 }] : []),
  ...(process.env.ORCA_OMP_SCALE_STRESS === '1' ? [{ roots: 16, children: 8 }] : [])
]) {
  test(`${workload.roots} roots × ${workload.children} native children keep compact status through quiet refresh and session replacement`, async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    test.setTimeout(600_000)
    const owned: OmpStatusRuntime[] = []
    try {
      await waitForSessionReady(orcaPage)
      const worktreeId = await waitForActiveWorktree(orcaPage)
      await ensureTerminalVisible(orcaPage)
      await orcaPage.evaluate(() => {
        const state = window.__store!.getState()
        if (!state.worktreeCardProperties.includes('inline-agents')) {
          state.setWorktreeCardProperties([...state.worktreeCardProperties, 'inline-agents'])
        }
      })
      const endpoint = await readHookEndpoint(electronApp)
      const names = CHILD_NAMES.slice(0, workload.children) // Reuse every name in every root.
      const roots: Root[] = []
      for (let index = 0; index < workload.roots; index++) {
        if (index > 0) {
          await orcaPage.evaluate((id) => {
            const state = window.__store!.getState()
            const tab = state.createTab(id)
            state.setActiveTab(tab.id)
            state.setActiveTabType('terminal', id)
          }, worktreeId)
        }
        await waitForActiveTerminalManager(orcaPage, 30_000)
        const pane = await waitForActivePaneHookDescriptor(orcaPage)
        const label = `Native OMP root ${String(index + 1).padStart(2, '0')}`
        const runtime = await startOmpStatusRuntime({
          ...pane,
          directory: testInfo.outputPath(`native-root-${index + 1}`),
          names,
          endpoint
        })
        owned.push(runtime)
        const root: Root = {
          ...pane,
          runtime,
          native: nativeRoot(runtime),
          label,
          remaining: names
        }
        roots.push(root)
        await runtime.command('prompt', { message: label })
        const state = (await runtime.command('get_state')).data
        expect(state?.sessionFile).toBeTruthy()
        root.native.sessionFile = state?.sessionFile
      }
      const initial = await expectRosters(orcaPage, roots)
      await expectCompact(orcaPage, roots[0]!, testInfo)
      const quietSince = Date.now()
      await orcaPage.waitForTimeout(QUIET_MS)
      const afterQuiet = await readStatuses(orcaPage)
      for (const root of roots) {
        expect(STABLE_FIELDS.map((field) => afterQuiet[root.paneKey]?.[field])).toEqual(
          STABLE_FIELDS.map((field) => initial[root.paneKey]![field])
        )
        expect(afterQuiet[root.paneKey]!.updatedAt).toBeGreaterThan(
          initial[root.paneKey]!.updatedAt
        )
        const facts = root.runtime.observations().filter((row) => row.at >= quietSince)
        expect(facts.filter((row) => row.kind === 'refresh').length).toBeGreaterThanOrEqual(2)
        expect(facts.filter((row) => row.kind === 'activity')).toEqual([])
      }
      const rebound = roots[0]!
      const live = roots.slice(1)
      // Retain only the first isolation fault, never a ledger of successful samples.
      await orcaPage.evaluate(
        ({ keys, baseline, fields }) => {
          let fault: string | undefined
          const unsubscribe = window.__store!.subscribe((state) => {
            for (const key of keys) {
              const row = state.agentStatusByPaneKey[key]
              if (
                !row ||
                JSON.stringify(fields.map((field) => row[field])) !==
                  JSON.stringify(fields.map((field) => baseline[key]![field]))
              ) {
                fault ??= key
              }
            }
          })
          globalThis.__ompIsolationCheck = () => {
            unsubscribe()
            return fault
          }
        },
        { keys: live.map((root) => root.paneKey), baseline: afterQuiet, fields: STABLE_FIELDS }
      )
      const refs = nativeChildren(rebound)
      const cancel = refs.find((ref) => ref.id.includes(names[1]!))!
      const complete = refs.find((ref) => ref.id.includes(names[0]!))!
      await rebound.runtime.command('cancel_subagent', { subagentId: cancel.id })
      await rebound.runtime.release(names[0]!)
      rebound.remaining = names.slice(2)
      await expect(async () => {
        const facts = rebound.runtime.observations()
        for (const [ref, status] of [
          [cancel, 'aborted'],
          [complete, 'completed']
        ] as const) {
          expect(facts).toContainEqual(
            expect.objectContaining({ kind: 'lifecycle', id: ref.id, status })
          )
        }
      }).toPass()
      await expectRosters(orcaPage, [rebound])
      await finishRoots(orcaPage, [rebound], names)
      await expect
        .poll(async () => (await rebound.runtime.command('get_state')).data?.isSettled)
        .toBe(true)
      await rebound.runtime.resetGates()
      const oldSessionId = rebound.native.sessionId
      await rebound.runtime.command('new_session')
      rebound.native = nativeRoot(rebound.runtime)
      expect(rebound.native.sessionId).not.toBe(oldSessionId)
      rebound.label = 'Native OMP rebound root'
      rebound.remaining = names
      await rebound.runtime.command('prompt', { message: rebound.label })
      await expect
        .poll(() =>
          rebound.runtime
            .observations()
            .some((row) => row.kind === 'root-model-held' && row.at >= rebound.native.at)
        )
        .toBe(true)
      rebound.native.sessionFile = (await rebound.runtime.command('get_state')).data?.sessionFile
      expect(rebound.native.sessionFile).toBeTruthy()
      expect(rebound.native.sessionFile).not.toBe(
        initial[rebound.paneKey]!.providerSession?.transcriptPath
      )
      await expect(async () => {
        const row = (await readStatuses(orcaPage))[rebound.paneKey]!
        expect(row).toMatchObject({
          state: 'working',
          prompt: rebound.label,
          providerSession: {
            id: rebound.native.sessionId,
            transcriptPath: rebound.native.sessionFile
          }
        })
        expect(row.subagents ?? []).toEqual([])
        expect(row.toolName).toBeUndefined()
        expect(row.lastAssistantMessage).toBeUndefined()
        expect(row.stateStartedAt).toBeGreaterThanOrEqual(rebound.native.at)
        if (row.turnStartedAt !== undefined) {
          expect(row.turnStartedAt).toBeGreaterThanOrEqual(rebound.native.at)
        }
      }).toPass({ timeout: 15_000 })
      await rebound.runtime.release('root-start')
      const afterRebind = await expectRosters(orcaPage, [rebound])
      const previousStart = Math.max(
        ...initial[rebound.paneKey]!.subagents!.map((child) => child.startedAt)
      )
      expect(
        afterRebind[rebound.paneKey]!.subagents!.every((child) => child.startedAt > previousStart)
      ).toBe(true)
      expect(await orcaPage.evaluate(() => globalThis.__ompIsolationCheck?.())).toBeUndefined()
      await finishRoots(orcaPage, roots, names)
      const compact = worktreeRow(orcaPage, worktreeId).locator('[data-compact-agent-list]')
      await expect(compact.locator('[data-agent-child-disclosure-button]')).toHaveCount(0)
      await expect(compact.locator('[aria-label="Working"]')).toHaveCount(0)
      expect(
        await electronApp.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every((window) => !window.isVisible())
        )
      ).toBe(true)
    } finally {
      await orcaPage.evaluate(() => globalThis.__ompIsolationCheck?.()).catch(() => {})
      // Release native bash children even after failed setup or assertions.
      await Promise.allSettled(owned.map((runtime) => runtime.stop()))
    }
  })
}
