import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getActiveTabId,
  getActiveWorktreeId,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  getTerminalContent,
  sendToTerminal,
  waitForActiveTerminalManager
} from './helpers/terminal'

const SIGWINCH_PROBE_PAGE = 100
const SIGWINCH_PROBE_ROWS = 12

type HiddenOutputDebugSnapshot = {
  hiddenRendererSkipCount: number
}

type HiddenOutputRecoveryWindow = Window & {
  __terminalPtyDataInjection?: {
    inject: (paneKey: string, data: string, meta?: { seq?: number; rawLength?: number }) => boolean
  }
  __terminalPtyOutputDebug?: {
    reset: () => void
    snapshot: () => HiddenOutputDebugSnapshot
  }
  __terminalHiddenSnapshotOverride?: {
    setPending: (
      ptyId: string,
      snapshot: { data: string; cols: number; rows: number; seq?: number }
    ) => void
    resolve: (ptyId: string) => void
  }
}

function buildSigwinchProbeRows(page: number): string {
  return Array.from(
    { length: SIGWINCH_PROBE_ROWS },
    (_, index) => `row ${String(page + index).padStart(3, '0')}`
  ).join('\r\n')
}

function buildSigwinchResetProbeCommand(): string {
  const script = [
    'let armed=false',
    `let page=${SIGWINCH_PROBE_PAGE}`,
    "const topLabel=['TOP','AFTER','SIGWINCH'].join('_')",
    `function paint(label){process.stdout.write('\\x1b[?1049h\\x1b[2J\\x1b[H'+label+' page='+page+'\\r\\n'+Array.from({length:${SIGWINCH_PROBE_ROWS}},(_,i)=>'row '+String(page+i).padStart(3,'0')).join('\\r\\n'))}`,
    "paint('VISIBLE_BEFORE_SWITCH')",
    "process.stdin.setEncoding('utf8')",
    "process.stdin.on('data',data=>{if(data.includes('ARM_SIGWINCH_PROBE')){armed=true;paint('ARMED_BEFORE_SWITCH')}})",
    "process.on('SIGWINCH',()=>{if(armed===false)return;page=0;paint(topLabel)})",
    'setInterval(()=>{},1000)'
  ].join(';')
  return `node -e ${JSON.stringify(script)}`
}

function buildSigwinchResetProbeSnapshot(label: string): string {
  return `\x1b[?1049h\x1b[2J\x1b[H${label} page=${SIGWINCH_PROBE_PAGE}\r\n${buildSigwinchProbeRows(SIGWINCH_PROBE_PAGE)}`
}

async function createAgentMarkedTerminalTab(
  page: Page,
  agent: 'codex',
  command: string
): Promise<string> {
  const worktreeId = (await getActiveWorktreeId(page))!
  return page.evaluate(
    ({ worktreeId, agent, command }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      const state = store.getState()
      const tab = state.createTab(worktreeId, undefined, undefined, {
        launchAgent: agent
      })
      state.queueTabStartupCommand(tab.id, {
        command,
        launchAgent: agent,
        telemetry: {
          agent_kind: agent,
          launch_source: 'tab_bar_quick_launch',
          request_kind: 'new'
        }
      })
      state.setActiveTab(tab.id)
      state.setActiveTabType('terminal')
      return tab.id
    },
    { worktreeId, agent, command }
  )
}

async function activateTerminalTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    store.getState().setActiveTab(id)
    store.getState().setActiveTabType('terminal')
  }, tabId)
  await expect
    .poll(
      () =>
        page
          .locator(`[data-testid="sortable-tab"][data-active="true"]`)
          .getAttribute('data-tab-id'),
      {
        timeout: 3_000
      }
    )
    .toBe(tabId)
}

async function waitForPanePtyIdOnTab(page: Page, tabId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((id) => {
          const manager = window.__paneManagers?.get(id)
          const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
          return pane?.container?.dataset?.ptyId ?? null
        }, tabId),
      { timeout: 15_000, message: `Pane for tab ${tabId} did not receive a PTY binding` }
    )
    .not.toBeNull()
}

async function readPaneIdentityOnTab(
  page: Page,
  tabId: string
): Promise<{ leafId: string; ptyId: string; cols: number; rows: number }> {
  const identity = await page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      return null
    }
    return {
      leafId: pane.container.dataset.leafId ?? null,
      ptyId: pane.container.dataset.ptyId ?? null,
      cols: pane.terminal.cols,
      rows: pane.terminal.rows
    }
  }, tabId)
  if (!identity?.leafId || !identity.ptyId) {
    throw new Error(`Pane identity for tab ${tabId} is incomplete`)
  }
  return {
    leafId: identity.leafId,
    ptyId: identity.ptyId,
    cols: identity.cols,
    rows: identity.rows
  }
}

async function resetHiddenOutputDebug(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as HiddenOutputRecoveryWindow).__terminalPtyOutputDebug?.reset()
  })
}

async function readHiddenOutputDebug(page: Page): Promise<HiddenOutputDebugSnapshot | null> {
  return page.evaluate(() => {
    return (window as HiddenOutputRecoveryWindow).__terminalPtyOutputDebug?.snapshot() ?? null
  })
}

async function injectPaneData(
  page: Page,
  paneKey: string,
  data: string,
  meta?: { seq?: number; rawLength?: number }
): Promise<void> {
  const injected = await page.evaluate(
    ({ paneKey, data, meta }) =>
      (window as HiddenOutputRecoveryWindow).__terminalPtyDataInjection?.inject(
        paneKey,
        data,
        meta
      ) ?? false,
    { paneKey, data, meta }
  )
  if (!injected) {
    throw new Error(`No terminal PTY data injector registered for ${paneKey}`)
  }
}

async function setHiddenSnapshotOverride(
  page: Page,
  ptyId: string,
  snapshot: { data: string; cols: number; rows: number; seq?: number }
): Promise<void> {
  await page.evaluate(
    ({ ptyId, snapshot }) => {
      const api = (window as HiddenOutputRecoveryWindow).__terminalHiddenSnapshotOverride
      if (!api) {
        throw new Error('Hidden snapshot override API unavailable')
      }
      api.setPending(ptyId, snapshot)
      api.resolve(ptyId)
    },
    { ptyId, snapshot }
  )
}

test.describe('Terminal tab switch SIGWINCH restore', () => {
  test('keeps an alternate-screen Codex viewport after hidden snapshot replay', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const shellTabId = (await getActiveTabId(orcaPage))!
    const agentTabId = await createAgentMarkedTerminalTab(
      orcaPage,
      'codex',
      buildSigwinchResetProbeCommand()
    )
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await waitForPanePtyIdOnTab(orcaPage, agentTabId)
    await expect
      .poll(() => getTerminalContent(orcaPage, 8_000), {
        timeout: 10_000,
        message: 'SIGWINCH probe TUI did not paint its initial scrolled page'
      })
      .toContain(`VISIBLE_BEFORE_SWITCH page=${SIGWINCH_PROBE_PAGE}`)
    const paneIdentity = await readPaneIdentityOnTab(orcaPage, agentTabId)
    await sendToTerminal(orcaPage, paneIdentity.ptyId, 'ARM_SIGWINCH_PROBE\n')
    await expect
      .poll(() => getTerminalContent(orcaPage, 8_000), {
        timeout: 10_000,
        message: 'SIGWINCH probe TUI did not arm after startup settled'
      })
      .toContain(`ARMED_BEFORE_SWITCH page=${SIGWINCH_PROBE_PAGE}`)
    await orcaPage.waitForTimeout(1_200)
    const armedContentAfterSettle = await getTerminalContent(orcaPage, 8_000)
    expect(armedContentAfterSettle).not.toContain('TOP_AFTER_SIGWINCH page=0')
    const paneKey = `${agentTabId}:${paneIdentity.leafId}`

    await activateTerminalTab(orcaPage, shellTabId)
    const hiddenFrame = ['\x1b[?2026h', 'hidden probe frame', '\x1b[?2026l'].join('\r\n')
    await resetHiddenOutputDebug(orcaPage)
    await injectPaneData(orcaPage, paneKey, hiddenFrame, {
      seq: hiddenFrame.length,
      rawLength: hiddenFrame.length
    })

    await expect
      .poll(async () => (await readHiddenOutputDebug(orcaPage))?.hiddenRendererSkipCount ?? 0, {
        timeout: 5_000,
        message: 'Codex probe hidden output did not take the skipped renderer path'
      })
      .toBeGreaterThan(0)
    await setHiddenSnapshotOverride(orcaPage, paneIdentity.ptyId, {
      data: buildSigwinchResetProbeSnapshot('RESTORED_SNAPSHOT'),
      cols: paneIdentity.cols,
      rows: paneIdentity.rows,
      seq: hiddenFrame.length
    })

    await activateTerminalTab(orcaPage, agentTabId)

    await expect
      .poll(
        async () => {
          const content = await getTerminalContent(orcaPage, 8_000)
          if (content.includes('TOP_AFTER_SIGWINCH page=0')) {
            return 'top'
          }
          return content.includes(`RESTORED_SNAPSHOT page=${SIGWINCH_PROBE_PAGE}`)
            ? 'snapshot'
            : 'pending'
        },
        {
          timeout: 10_000,
          message: 'hidden snapshot replay did not restore the probe TUI page'
        }
      )
      .toBe('snapshot')
    await orcaPage.waitForTimeout(1_200)
    const contentAfterSettle = await getTerminalContent(orcaPage, 8_000)
    expect(contentAfterSettle).toContain(`RESTORED_SNAPSHOT page=${SIGWINCH_PROBE_PAGE}`)
    expect(contentAfterSettle).not.toContain('TOP_AFTER_SIGWINCH page=0')
  })
})
