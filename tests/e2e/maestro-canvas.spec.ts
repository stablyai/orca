import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { test, expect } from './helpers/orca-app'
import { launchNativeMaestroFixture } from './helpers/maestro-fixture'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor } from './helpers/terminal'
import { RuntimeClient } from '../../src/cli/runtime-client'
import { AgentGraphViewSchema } from '../../src/shared/maestro-contract'
import { openMaestro as openWorkspaceMaestro } from './fixtures/maestro-workspace-tab-canvas/evidence'
import {
  MAESTRO_EVIDENCE_SURFACE_ID,
  MAESTRO_EVIDENCE_WORKER_NODE_ID,
  maestroEvidenceView,
  type MaestroEvidenceAnchor,
  type MaestroEvidencePage,
  type MaestroEvidencePhase
} from '../../.visual-evidence/maestro-worktree-canvas/orc11-evidence-board'
import type { Page } from '@stablyai/playwright-test'

test.describe('Maestro Canvas journal fixture', () => {
  test('pans zooms drags and authors a note and typed link on the real Canvas', async () => {
    const native = await launchNativeMaestroFixture()
    try {
      const page = native.page
      const canvas = page.getByLabel('Maestro graph')
      await expect(canvas).toBeVisible()
      await page.getByLabel('Zoom in').click()
      await expect(page.getByText('125%')).toBeVisible()
      const node = page.locator('[data-maestro-node="worker"]')
      const bounds = await node.boundingBox()
      if (!bounds) {
        throw new Error('Worker node did not paint')
      }
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      await page.mouse.down()
      await page.mouse.move(bounds.x + bounds.width / 2 + 48, bounds.y + bounds.height / 2 + 24)
      await page.mouse.up()
      await page.getByRole('button', { name: 'Author link' }).click()
      await expect(page.getByLabel('Typed link editor')).toBeVisible()
      await page.getByRole('button', { name: 'Create link' }).click()
      await expect(page.locator('[data-orc11-authoring-receipt]')).toHaveText(
        'link:edge-worker-browser applied'
      )
      await expect(page.locator('[data-maestro-edge-id="edge-worker-browser"]')).toBeVisible()
      await page.getByRole('button', { name: 'Author note' }).click()
      await expect(page.getByLabel('Maestro note editor')).toBeVisible()
      await page.getByLabel('Note title').fill('Observed terminal handoff')
      await page
        .getByLabel('Note Markdown')
        .fill('Tracked terminal stays distinct from loose user terminal.')
      await page.getByLabel('Maestro note editor').getByRole('button', { name: 'Save' }).click()
      await expect(page.locator('[data-maestro-node="note-observed"]')).toHaveAttribute(
        'aria-label',
        /Observed terminal handoff, Saved/
      )
      await expect(page.locator('[data-orc11-authoring-receipt]')).toHaveText(
        'note:note-observed revision:1 applied'
      )
    } finally {
      await native.close()
    }
  })
})

const EVIDENCE_ROOT = resolve('.visual-evidence/maestro-worktree-canvas')
const CAPTURE_PROFILES = [
  { id: 'desktop', width: 1920, height: 1080 },
  { id: 'notebook', width: 1366, height: 768 }
] as const
const BRIDGE_READY_MARKER = 'ORC11_BRIDGE_AGENT_READY'

/**
 * The runtime only accepts an AgentGraphView from the run's own coordinator, and that
 * authority is the launch secret Orca hands the agent process it started. So the
 * coordinator here is a real launched agent whose process relays the run's requests:
 * a direct client call from the Playwright worker is a local user and stays unauthorized.
 */
function bridgeAgentSource(bridgeDir: string, cliRoot: string, userDataPath: string): string {
  return `#!/usr/bin/env node
const { existsSync, readdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { randomUUID } = require('node:crypto')
const { readMetadata } = require(${JSON.stringify(join(cliRoot, 'runtime', 'metadata.js'))})
const { sendRequest } = require(${JSON.stringify(join(cliRoot, 'runtime', 'transport.js'))})
const bridgeDir = ${JSON.stringify(bridgeDir)}
const evidence = {}
if (process.env.ORCA_TERMINAL_HANDLE) evidence.terminalHandle = process.env.ORCA_TERMINAL_HANDLE
if (process.env.ORCA_PANE_KEY) evidence.paneKey = process.env.ORCA_PANE_KEY
if (process.env.ORCA_AGENT_LAUNCH_TOKEN) evidence.launchToken = process.env.ORCA_AGENT_LAUNCH_TOKEN
process.stdout.write(${JSON.stringify(BRIDGE_READY_MARKER)} + '\\n')
const settle = (label, payload) =>
  writeFileSync(join(bridgeDir, label + '-result.json'), JSON.stringify(payload))
const claimed = new Set()
setInterval(() => {
  for (const entry of readdirSync(bridgeDir)) {
    if (!entry.endsWith('-request.json')) continue
    const label = entry.slice(0, -'-request.json'.length)
    if (claimed.has(label) || existsSync(join(bridgeDir, label + '-result.json'))) continue
    claimed.add(label)
    const request = JSON.parse(readFileSync(join(bridgeDir, entry), 'utf8'))
    sendRequest(readMetadata(${JSON.stringify(userDataPath)}), request.method, request.params, 30000, {
      compatibilityInvocationId: randomUUID(),
      orchestrationCompatibilityEvidence: evidence
    })
      .then((response) => settle(label, { ...response, evidenceKeys: Object.keys(evidence) }))
      .catch((error) =>
        settle(label, { ok: false, error: String(error), evidenceKeys: Object.keys(evidence) })
      )
  }
}, 150)
process.stdin.resume()
`
}

/** Runs one RPC inside the launched coordinator agent so the runtime sees its real caller. */
async function callFromCoordinatorAgent(
  bridgeDir: string,
  label: string,
  method: string,
  params: unknown
): Promise<void> {
  const resultPath = join(bridgeDir, `${label}-result.json`)
  writeFileSync(join(bridgeDir, `${label}-request.json`), JSON.stringify({ method, params }))
  await expect.poll(() => existsSync(resultPath), { timeout: 60_000 }).toBe(true)
  const response = JSON.parse(readFileSync(resultPath, 'utf8')) as {
    ok?: boolean
    error?: unknown
    evidenceKeys?: string[]
  }
  expect(
    response.ok === true,
    `${method} from the coordinator agent failed: ${JSON.stringify(response.error ?? response)}; caller evidence: ${JSON.stringify(response.evidenceKeys ?? [])}`
  ).toBe(true)
}

async function startProofPage(): Promise<{
  url: string
  origin: string
  close: () => Promise<void>
}> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(
      `<!doctype html><html><head><style>html,body{background:#fff;color:#111;margin:0;font:16px system-ui}main{padding:24px}</style></head><body><main><h1>ORC-11 native Browser proof</h1><p>Harness-owned visible page.</p></main></body></html>`
    )
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url: `${origin}/orc11-browser-proof`,
    origin,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose()))
      )
  }
}

/** The Canvas can only preview a page Orca actually owns, so the run opens the real one. */
async function openHarnessBrowserPage(
  page: Page,
  url: string
): Promise<{ tabId: string; pageId: string }> {
  const created = await page.evaluate((targetUrl) => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    if (!state || !worktreeId) {
      return null
    }
    const tab = state.createBrowserTab(worktreeId, targetUrl, {
      title: 'ORC-11 native Browser proof',
      activate: true
    })
    return tab.activePageId ? { tabId: tab.id, pageId: tab.activePageId } : null
  }, url)
  if (!created) {
    throw new Error('Orca did not open the harness-owned Browser page')
  }
  await expect
    .poll(
      () =>
        page.evaluate(async (tabId) => {
          const slot = document.querySelector(`[data-browser-overlay-tab-id="${tabId}"]`)
          const webview = slot?.querySelector('webview') as Electron.WebviewTag | null
          try {
            return webview
              ? ((await webview.executeJavaScript(
                  'document.querySelector("h1")?.textContent ?? null'
                )) as string | null)
              : null
          } catch {
            return null
          }
        }, created.tabId),
      { timeout: 30_000 }
    )
    .toBe('ORC-11 native Browser proof')
  return created
}

async function launchCoordinatorAgent(page: Page, bridgeCommand: string): Promise<void> {
  await page.evaluate(async (command) => {
    const store = window.__store
    if (!store) {
      throw new Error('Orca store is unavailable')
    }
    await store.getState().updateSettings({
      defaultTuiAgent: 'claude',
      agentCmdOverrides: { claude: command },
      agentDefaultArgs: { claude: '' }
    })
  }, bridgeCommand)
  await page.getByRole('button', { name: 'New tab' }).click({ force: true })
  const launchOption = page.getByRole('menuitem', { name: /^Claude(?:\s|$)/i }).first()
  await expect(launchOption).toBeVisible({ timeout: 15_000 })
  await launchOption.click({ force: true })
}

/**
 * The surface reads the run once when it mounts, so a board published or advanced
 * afterwards is only observable by entering Maestro again through the same command.
 */
async function reopenMaestroTab(page: Page, tabId: string): Promise<string> {
  await page.evaluate((id) => {
    window.__store?.getState().closeUnifiedTab(id)
  }, tabId)
  return (await openWorkspaceMaestro(page)).id
}

async function setRightSidebarOpen(page: Page, open: boolean): Promise<void> {
  await page.evaluate((next) => {
    window.__store?.getState().setRightSidebarOpen(next)
  }, open)
}

/** The board culls offscreen windows, so every assertion and shot starts from the whole graph. */
async function fitBoard(page: Page): Promise<void> {
  await page.getByLabel('Fit graph to view').click()
  await expect(page.locator('[data-maestro-canvas]')).toBeVisible()
}

/** Notes carry their tone as a Markdown callout, so a board proves the tones only by using them. */
const TONED_NOTES = [
  {
    node_id: 'note-browser-release-context',
    position: { x: 470, y: 60 },
    title: 'Browser release context',
    markdown:
      '> [!DECISION]\n\nThe Browser pane owns the exact page capture before focus returns to Canvas.',
    heading: 'The Browser pane owns the exact page capture'
  },
  {
    node_id: 'note-terminal-identity',
    position: { x: 880, y: 60 },
    title: 'Terminal identity',
    markdown:
      '> [!WARNING]\n\nThe loose user terminal stays connected and must never appear in a cleanup receipt.',
    heading: 'The loose user terminal stays connected'
  },
  {
    node_id: 'note-carry-forward',
    position: { x: 1290, y: 60 },
    title: 'Carry-forward finding',
    markdown:
      '> [!BLOCKER]\n\nORC-10 hardening stays carry-forward, so the run cannot report 100 percent.',
    heading: 'ORC-10 hardening stays carry-forward'
  }
] as const

/** The Canvas must paint the exact page, never the placeholder that means "no capture". */
async function expectRenderedBrowserPreview(page: Page): Promise<void> {
  const card = page.locator(`[data-maestro-browser-surface="${MAESTRO_EVIDENCE_SURFACE_ID}"]`)
  await expect(card).toBeVisible()
  // Surface the runtime's own reason instead of a bare "not visible" when the capture fails.
  await expect
    .poll(
      () =>
        card.evaluate((element) => {
          if (element.querySelector('img')) {
            return 'rendered'
          }
          const failed = element.querySelector('[data-maestro-preview-error]')
          return (
            failed?.getAttribute('data-maestro-preview-error') ??
            (element as HTMLElement).innerText.replaceAll('\n', ' · ')
          )
        }),
      { timeout: 20_000 }
    )
    .toBe('rendered')
  await expect(card.getByText('Capture unavailable')).toHaveCount(0)
  await expect(card.getByText('Loading exact capture…')).toHaveCount(0)
}

async function captureCanvas(page: Page, phase: MaestroEvidencePhase): Promise<void> {
  if (process.env.ORC11_CAPTURE_EVIDENCE !== '1') {
    return
  }
  mkdirSync(EVIDENCE_ROOT, { recursive: true })
  for (const profile of CAPTURE_PROFILES) {
    await page.setViewportSize({ width: profile.width, height: profile.height })
    // At notebook width the file sidebar leaves the board too small to read; the desktop
    // shot keeps it so the surrounding Orca chrome is still on the record.
    await setRightSidebarOpen(page, profile.id !== 'notebook')
    const board = page.locator('[data-maestro-canvas]')
    await expect(board).toBeVisible()
    await fitBoard(page)
    await expectRenderedBrowserPreview(page)
    const bounds = await board.boundingBox()
    // A shot of a collapsed board would grade a redesign that never painted.
    expect(bounds, 'the Canvas collapsed instead of filling the shell').toBeTruthy()
    expect((bounds!.width * bounds!.height) / (profile.width * profile.height)).toBeGreaterThan(0.4)
    await page.screenshot({
      path: join(EVIDENCE_ROOT, `orc11-${phase}-${profile.id}.png`),
      animations: 'disabled',
      caret: 'hide',
      scale: 'css'
    })
  }
  await setRightSidebarOpen(page, true)
}

type EvidenceRunArgs = {
  orcaPage: Page
  userDataDir: string
  bridgeDir: string
  proof: { url: string; origin: string }
  onBrowserTab: (tabId: string) => void
}

async function runIntegratedCanvasEvidence(args: EvidenceRunArgs): Promise<void> {
  const { orcaPage, userDataDir, bridgeDir, proof } = args
  const pane = await waitForActivePaneHookDescriptor(orcaPage)
  const client = new RuntimeClient(userDataDir, 30_000, null, null)
  const coordinator = await client.call<{ terminal: { handle: string } }>('terminal.resolvePane', {
    paneKey: pane.paneKey
  })
  const handle = coordinator.result.terminal.handle
  const run = await client.call<{ run: { id: string } }>('orchestration.runCreate', {
    objective: 'ORC-11 integrated Canvas evidence',
    from: handle
  })
  const terminal = await client.call<{ terminal: { worktreeId: string } }>('terminal.show', {
    terminal: handle
  })
  // A managed worktree id is `<repository id>::<canonical path>`.
  const [repositoryId, workspacePath] = terminal.result.terminal.worktreeId.split('::')

  const opened = await openHarnessBrowserPage(orcaPage, proof.url)
  args.onBrowserTab(opened.tabId)
  const evidencePage: MaestroEvidencePage = {
    id: opened.pageId,
    url: proof.url,
    origin: proof.origin
  }

  const scope = await openWorkspaceMaestro(orcaPage)
  const anchor: MaestroEvidenceAnchor = {
    repository_id: repositoryId,
    execution_host_id: scope.host,
    workspace_key: scope.workspace,
    run_id: run.result.run.id
  }
  const view = (phase: MaestroEvidencePhase): Record<string, unknown> =>
    maestroEvidenceView(anchor, workspacePath, phase, evidencePage)
  // Fail on the exact contract issue here rather than on the runtime's generic rejection.
  expect(AgentGraphViewSchema.safeParse(view('active')).error?.issues ?? []).toEqual([])
  expect(AgentGraphViewSchema.safeParse(view('released')).error?.issues ?? []).toEqual([])

  await callFromCoordinatorAgent(bridgeDir, 'projection-active', 'maestro.projection.apply', {
    workspace: anchor,
    view: view('active')
  })
  for (const [index, note] of TONED_NOTES.entries()) {
    await callFromCoordinatorAgent(bridgeDir, `note-${index}`, 'maestro.document.authoring.apply', {
      schema_version: 1,
      protocol: 'maestro-document-authoring-mutation/v1',
      mutation_id: `mutation-orc11-${note.node_id}`,
      scope: {
        execution_host_id: anchor.execution_host_id,
        workspace_key: anchor.workspace_key,
        repository_id: anchor.repository_id,
        run_id: anchor.run_id
      },
      expected_revision: index,
      operation: {
        kind: 'create-note',
        node_id: note.node_id,
        position: note.position,
        title: note.title,
        markdown: note.markdown
      }
    })
  }

  // The surface resolved before the run existed, so re-enter it through the same command.
  const active = await reopenMaestroTab(orcaPage, scope.id)
  await expect(orcaPage.locator('[data-maestro-canvas]')).toBeVisible({ timeout: 30_000 })
  await fitBoard(orcaPage)
  await expect(
    orcaPage.locator(`[data-maestro-node="${MAESTRO_EVIDENCE_WORKER_NODE_ID}"]`)
  ).toBeVisible()
  for (const note of TONED_NOTES) {
    await expect(orcaPage.locator(`[data-maestro-node="${note.node_id}"]`)).toBeVisible()
    await expect(orcaPage.getByText(note.heading)).toBeVisible()
  }
  // Tone is only proved when more than the default observation is on the board at once.
  const tones = await orcaPage.evaluate(() =>
    [...document.querySelectorAll('[data-maestro-tone]')].map((element) =>
      element.getAttribute('data-maestro-tone')
    )
  )
  expect(new Set(tones.filter((tone) => tone && tone !== 'observation')).size).toBeGreaterThan(1)
  await expectRenderedBrowserPreview(orcaPage)
  await captureCanvas(orcaPage, 'active')

  await callFromCoordinatorAgent(bridgeDir, 'projection-released', 'maestro.projection.apply', {
    workspace: anchor,
    view: view('released')
  })
  await reopenMaestroTab(orcaPage, active)
  await expect(orcaPage.locator('[data-maestro-canvas]')).toBeVisible({ timeout: 30_000 })
  await fitBoard(orcaPage)
  // The headline carries the number, so carry-forward cannot be read off ambiguous text.
  const partialProgress = orcaPage.getByLabel(`Run Run ${anchor.run_id}: partial`)
  await expect(partialProgress).toBeVisible({ timeout: 30_000 })
  await expect(partialProgress.getByText('86%', { exact: true })).toBeVisible()
  await expect(partialProgress.locator('[data-maestro-progress-percent]')).toHaveAttribute(
    'data-maestro-progress-percent',
    '86'
  )
  await expectRenderedBrowserPreview(orcaPage)
  await captureCanvas(orcaPage, 'released')
}

test.describe('Maestro integrated Canvas in the Orca shell', () => {
  test('renders the published coordinator board in the built app', async ({
    orcaPage,
    electronApp
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const bridgeDir = mkdtempSync(join(os.tmpdir(), 'orca-orc11-canvas-'))
    const proof = await startProofPage()
    let browserTabId: string | null = null
    try {
      const bridgePath = join(bridgeDir, 'orc11-coordinator-agent.cjs')
      writeFileSync(bridgePath, bridgeAgentSource(bridgeDir, resolve('out/cli'), userDataDir), {
        mode: 0o700
      })
      await launchCoordinatorAgent(orcaPage, `node ${bridgePath}`)
      await runIntegratedCanvasEvidence({
        orcaPage,
        userDataDir,
        bridgeDir,
        proof,
        onBrowserTab: (id) => {
          browserTabId = id
        }
      })
    } finally {
      if (browserTabId) {
        await orcaPage.evaluate((id) => {
          window.__store?.getState().closeBrowserTab(id)
        }, browserTabId)
      }
      await proof.close()
      rmSync(bridgeDir, { recursive: true, force: true })
      expect(existsSync(bridgeDir), 'the capture bridge outlived the run').toBe(false)
    }
  })
})
