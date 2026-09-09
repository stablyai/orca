import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stripAnsiEscapeSequences } from '../../src/shared/ansi-escape-sequences'
import { test, expect } from './helpers/orca-app'
import {
  runNodeScriptInTerminal,
  stageNodeScriptForTerminal
} from './helpers/run-node-script-in-terminal'
import { registerTerminalPaneMountReadiness } from './helpers/terminal-pane-mount-readiness'
import {
  focusActiveTerminalInput,
  getTerminalContent,
  waitForPaneIdentitySnapshot,
  waitForTerminalOutput
} from './helpers/terminal'

type QuickCommandIdentity = {
  marker: string
  paneKey: string
  pid: number
  tabId: string
}

type QueueObservation = {
  pending: boolean
  ptyIds: string[]
}

type QueueObservationWindow = Window & {
  __quickCommandQueueObservations?: QueueObservation[]
  __stopQuickCommandQueueObservations?: () => void
}

function exactMarkerLineCount(content: string, marker: string): number {
  return stripAnsiEscapeSequences(content)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line === marker).length
}

test.describe('Quick Command startup recovery', () => {
  registerTerminalPaneMountReadiness()

  test('visible Quick Command survives a forced pre-bind recovery on one fresh PTY', async ({
    orcaPage
  }) => {
    const siblingBefore = await waitForPaneIdentitySnapshot(orcaPage, 1)
    const siblingPtyId = siblingBefore.panes[0]?.ptyId
    if (!siblingPtyId) {
      throw new Error('Sibling terminal has no live PTY')
    }

    const siblingMarker = `ORCA_QUICK_COMMAND_SIBLING_${randomUUID()}`
    const siblingProbe = await runNodeScriptInTerminal(
      orcaPage,
      siblingPtyId,
      `process.stdout.write(${JSON.stringify(`${siblingMarker}\n`)})`
    )
    await waitForTerminalOutput(orcaPage, siblingMarker)
    siblingProbe.cleanup()

    const marker = `ORCA_QUICK_COMMAND_RECOVERY_${randomUUID()}`
    const label = `Recovery sentinel ${randomUUID()}`
    const identityPath = path.join(os.tmpdir(), `orca-quick-command-identity-${randomUUID()}.json`)
    const staged = stageNodeScriptForTerminal(
      `
const { writeFileSync } = require('node:fs')
const identity = {
  marker: ${JSON.stringify(marker)},
  paneKey: process.env.ORCA_PANE_KEY || '',
  pid: process.pid,
  tabId: process.env.ORCA_TAB_ID || ''
}
writeFileSync(${JSON.stringify(identityPath)}, JSON.stringify(identity), { flag: 'wx' })
process.stdout.write(${JSON.stringify(`${marker}\n`)})
`.trim()
    )

    try {
      await orcaPage.evaluate(
        async ({ command, label }) => {
          const store = window.__store
          if (!store) {
            throw new Error('Renderer store unavailable')
          }
          await store.getState().updateSettings({
            terminalQuickCommands: [
              {
                id: 'e2e-pre-bind-recovery',
                label,
                scope: { type: 'global' },
                action: 'terminal-command',
                command,
                appendEnter: true
              }
            ]
          })
          const spawnBarrier = window.__terminalPtyPreSpawnE2EBarrier
          if (!spawnBarrier) {
            throw new Error('Terminal PTY pre-spawn E2E barrier unavailable')
          }
          spawnBarrier.arm()
        },
        { command: staged.command, label }
      )

      const quickCommandButton = orcaPage.getByRole('button', {
        name: `Run quick command: ${label}`
      })
      await expect(quickCommandButton).toBeVisible()
      await quickCommandButton.click()
      await orcaPage.evaluate(async () => {
        const spawnBarrier = window.__terminalPtyPreSpawnE2EBarrier
        if (!spawnBarrier) {
          throw new Error('Terminal PTY pre-spawn E2E barrier unavailable')
        }
        await spawnBarrier.waitUntilBlocked()
      })

      const blocked = await orcaPage.evaluate(() => {
        const store = window.__store
        if (!store) {
          throw new Error('Renderer store unavailable')
        }
        const state = store.getState()
        const tabId = state.activeTabId
        if (!tabId) {
          throw new Error('Quick Command did not create an active tab')
        }
        return {
          generation:
            state.tabsByWorktree[state.activeWorktreeId ?? '']?.find((tab) => tab.id === tabId)
              ?.generation ?? 0,
          pending: state.pendingStartupByTabId[tabId]?.command ?? null,
          status: window.__terminalPtyPreSpawnE2EBarrier?.status(),
          tabId
        }
      })
      expect(blocked.pending).toBe(staged.command)
      expect(blocked.status).toBe('blocked')

      await orcaPage.evaluate((tabId) => {
        const store = window.__store
        if (!store) {
          throw new Error('Renderer store unavailable')
        }
        const target = window as QueueObservationWindow
        const observations: QueueObservation[] = []
        const observe = (): void => {
          const state = store.getState()
          observations.push({
            pending: state.pendingStartupByTabId[tabId] !== undefined,
            ptyIds: [...(state.ptyIdsByTabId[tabId] ?? [])]
          })
        }
        target.__quickCommandQueueObservations = observations
        target.__stopQuickCommandQueueObservations = store.subscribe(observe)
        observe()
      }, blocked.tabId)

      const remounted = await orcaPage.evaluate((tabId) => {
        const state = window.__store?.getState()
        if (!state) {
          throw new Error('Renderer store unavailable')
        }
        return state.remountTerminalTabForRecovery(tabId)
      }, blocked.tabId)
      expect(remounted).toBe(true)

      // Keep the original pre-spawn attempt gated until React has committed the
      // successor pane. Releasing earlier lets a loaded CI renderer finish the
      // old mount's teardown before the replacement reaches its connect path.
      await expect
        .poll(
          () =>
            orcaPage.evaluate(
              ({ expectedGeneration, tabId }) => {
                const state = window.__store?.getState()
                const manager = window.__paneManagers?.get(tabId)
                const pane = manager?.getPanes()[0]
                const tab = state?.tabsByWorktree[state.activeWorktreeId ?? '']?.find(
                  (candidate) => candidate.id === tabId
                )
                return {
                  generation: tab?.generation ?? 0,
                  leafReady: Boolean(pane?.leafId),
                  pending: state?.pendingStartupByTabId[tabId]?.command ?? null,
                  expectedGeneration
                }
              },
              { expectedGeneration: blocked.generation + 1, tabId: blocked.tabId }
            ),
          { message: 'Successor mount did not become ready before barrier release' }
        )
        .toEqual({
          generation: blocked.generation + 1,
          leafReady: true,
          pending: staged.command,
          expectedGeneration: blocked.generation + 1
        })
      await orcaPage.evaluate(() => window.__terminalPtyPreSpawnE2EBarrier?.release())

      let targetPtyId = ''
      let targetLeafId = ''
      const successorReady = (): Promise<{
        generation: number
        leafReady: boolean
        pending: string | null
        ptyReady: boolean
        expectedGeneration: number
      }> =>
        orcaPage.evaluate(
          ({ expectedGeneration, tabId }) => {
            const state = window.__store?.getState()
            const manager = window.__paneManagers?.get(tabId)
            const pane = manager?.getPanes()[0]
            const tab = state?.tabsByWorktree[state.activeWorktreeId ?? '']?.find(
              (candidate) => candidate.id === tabId
            )
            return {
              generation: tab?.generation ?? 0,
              leafReady: Boolean(pane?.leafId),
              pending: state?.pendingStartupByTabId[tabId]?.command ?? null,
              ptyReady: Boolean(pane?.container.dataset.ptyId),
              expectedGeneration
            }
          },
          { expectedGeneration: blocked.generation + 1, tabId: blocked.tabId }
        )
      try {
        await expect
          .poll(successorReady, {
            timeout: 60_000,
            message: 'Successor mount did not bind its fresh Quick Command PTY'
          })
          .toEqual({
            generation: blocked.generation + 1,
            leafReady: true,
            pending: null,
            ptyReady: true,
            expectedGeneration: blocked.generation + 1
          })
      } catch (error) {
        const diagnostics = await orcaPage.evaluate(() => ({
          ptyConnect: (window as Window & { __ptyConnectDiag?: string[] }).__ptyConnectDiag ?? [],
          barrier: window.__terminalPtyPreSpawnE2EBarrier?.status() ?? 'missing'
        }))
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\nDiagnostics: ${JSON.stringify(diagnostics)}`
        )
      }

      const successor = await orcaPage.evaluate((tabId) => {
        const pane = window.__paneManagers?.get(tabId)?.getPanes()[0]
        return {
          leafId: pane?.leafId ?? '',
          ptyId: pane?.container.dataset.ptyId ?? ''
        }
      }, blocked.tabId)
      targetPtyId = successor.ptyId
      targetLeafId = successor.leafId
      expect(targetPtyId).not.toBe('')
      expect(targetLeafId).not.toBe('')
      expect(targetPtyId).not.toBe(siblingPtyId)

      const queueObservations = await orcaPage.evaluate(() => {
        const target = window as QueueObservationWindow
        target.__stopQuickCommandQueueObservations?.()
        target.__stopQuickCommandQueueObservations = undefined
        return target.__quickCommandQueueObservations ?? []
      })
      const firstConsumed = queueObservations.find((observation) => !observation.pending)
      expect(firstConsumed?.ptyIds).toContain(targetPtyId)

      await expect
        .poll(
          () =>
            orcaPage.evaluate((tabId) => {
              const pane = window.__paneManagers?.get(tabId)?.getPanes()[0]
              return pane?.serializeAddon.serialize() ?? ''
            }, blocked.tabId),
          { message: 'Quick Command marker never reached the visible xterm' }
        )
        .toContain(marker)
      const targetContent = await orcaPage.evaluate((tabId) => {
        const pane = window.__paneManagers?.get(tabId)?.getPanes()[0]
        return pane?.serializeAddon.serialize() ?? ''
      }, blocked.tabId)
      expect(exactMarkerLineCount(targetContent, marker)).toBe(1)

      await expect.poll(() => existsSync(identityPath)).toBe(true)
      const identity = JSON.parse(readFileSync(identityPath, 'utf8')) as QuickCommandIdentity
      expect(identity).toMatchObject({
        marker,
        paneKey: `${blocked.tabId}:${targetLeafId}`,
        tabId: blocked.tabId
      })
      expect(identity.pid).toBeGreaterThan(0)

      const ptyIdentity = await orcaPage.evaluate(
        async ({ siblingPtyId, siblingTabId, tabId, targetPtyId }) => {
          const state = window.__store?.getState()
          const layout = state?.terminalLayoutsByTabId[tabId]
          const sessions = await window.api.pty.listSessions()
          return {
            layoutPtyIds: Object.values(layout?.ptyIdsByLeafId ?? {}),
            siblingLive: await window.api.pty.hasPty(siblingPtyId),
            siblingStorePtyIds: state?.ptyIdsByTabId[siblingTabId] ?? [],
            targetLive: await window.api.pty.hasPty(targetPtyId),
            targetSessionIds: sessions
              .filter((session) => session.id === targetPtyId)
              .map((session) => session.id),
            targetStorePtyIds: state?.ptyIdsByTabId[tabId] ?? []
          }
        },
        { siblingPtyId, siblingTabId: siblingBefore.tabId, tabId: blocked.tabId, targetPtyId }
      )
      expect(ptyIdentity.targetLive).toBe(true)
      expect(ptyIdentity.targetSessionIds).toEqual([targetPtyId])
      expect(ptyIdentity.targetStorePtyIds).toContain(targetPtyId)
      expect(ptyIdentity.layoutPtyIds).toContain(targetPtyId)
      expect(ptyIdentity.siblingLive).toBe(true)
      expect(ptyIdentity.siblingStorePtyIds).toContain(siblingPtyId)

      const siblingAfterMarker = `ORCA_QUICK_COMMAND_SIBLING_AFTER_${randomUUID()}`
      await orcaPage.evaluate(
        (tabId) => window.__store?.getState().setActiveTab(tabId),
        siblingBefore.tabId
      )
      await expect
        .poll(() => orcaPage.evaluate(() => window.__store?.getState().activeTabId))
        .toBe(siblingBefore.tabId)
      await focusActiveTerminalInput(orcaPage)
      await orcaPage.keyboard.type(`echo ${siblingAfterMarker}`)
      await orcaPage.keyboard.press('Enter')
      await expect
        .poll(async () => (await getTerminalContent(orcaPage)).split(siblingAfterMarker).length - 1)
        .toBeGreaterThanOrEqual(1)
    } finally {
      await orcaPage
        .evaluate(() => window.__terminalPtyPreSpawnE2EBarrier?.release())
        .catch(() => {})
      staged.cleanup()
      rmSync(identityPath, { force: true })
    }
  })
})
