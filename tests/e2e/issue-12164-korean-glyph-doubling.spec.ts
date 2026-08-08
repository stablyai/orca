import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  getTerminalContent,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { nodeTerminalCommand } from './terminal-node-command'
import {
  forceDomRenderer,
  installPaneLookup,
  readBuffer,
  readCanvas,
  readGrid,
  waitForStableGrid,
  type PayloadCase
} from './issue-12164-korean-glyph-doubling-probe'

// Issue #12164: `프로젝트 브랜딩 이름 확정` reported as `프프로로젝젝트트 …`.
// The payload is agent output, so no IME and no keystrokes are involved — the
// question is only whether the doubling lives in the data model or the paint.
const KOREAN = '프로젝트 브랜딩 이름 확정'
const CASES: PayloadCase[] = [
  // 11 wide glyphs (2 columns each) + 3 spaces.
  { id: 'korean', text: KOREAN, expectedColumns: 25 },
  { id: 'ascii', text: 'project branding name', expectedColumns: 21 },
  { id: 'chinese', text: '项目品牌名称确定', expectedColumns: 16 },
  // Multi-byte UTF-8 but narrow: separates "multi-byte" from "double-width".
  { id: 'cyrillic', text: 'проект бренд имя', expectedColumns: 16 }
]
const DONE_MARKER = 'ISSUE_12164_EMIT_DONE'
const EMIT_FIXTURE_PATH = path.join(process.cwd(), 'tests/e2e/fixtures/issue-12164-korean-emit.cjs')

function inspectionReport(label: string, value: unknown): string {
  return `${label}: ${JSON.stringify(value, null, 2)}`
}

test.describe('issue #12164 Korean glyph doubling', () => {
  for (const renderer of ['webgl', 'dom'] as const) {
    test(`emitted Korean reads back identical from the buffer, the selection and the ${renderer} canvas`, async ({
      orcaPage
    }) => {
      await runProbe(orcaPage, renderer)
    })
  }
})

async function runProbe(orcaPage: Page, renderer: 'webgl' | 'dom'): Promise<void> {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const ptyId = await waitForActivePanePtyId(orcaPage)
  await installPaneLookup(orcaPage)
  if (renderer === 'dom') {
    await forceDomRenderer(orcaPage)
  }
  // Disabling GPU re-fits the pane; read the grid only once it has settled, or a
  // stale emit-time reading turns a benign resize into a false doubling call.
  const gridAtEmit = await waitForStableGrid(orcaPage)

  // A real child process writing to the real PTY — exactly the shape of the
  // agent output in the report, and with no IME anywhere in the path.
  await execInTerminal(orcaPage, ptyId, nodeTerminalCommand([EMIT_FIXTURE_PATH]))
  await waitForTerminalOutput(orcaPage, DONE_MARKER, 30_000)
  await orcaPage.waitForTimeout(750)

  const gridAtRead = await readGrid(orcaPage)
  const bufferReadings = await readBuffer(orcaPage, CASES)
  const locatedRows = bufferReadings
    .filter((reading) => reading.row !== null)
    .map((reading) => ({ id: reading.id, row: reading.row as number }))
  const canvas = await readCanvas(orcaPage, locatedRows)

  const evidence = [
    inspectionReport('terminalContent', await getTerminalContent(orcaPage, 2000)),
    inspectionReport('grid', { emit: gridAtEmit, read: gridAtRead }),
    inspectionReport('rendererRequested', renderer),
    inspectionReport('rendererActual', canvas.renderer),
    inspectionReport('buffer', bufferReadings),
    inspectionReport('canvas', canvas.readings)
  ].join('\n')
  test.info().annotations.push({
    type: 'issue-12164-evidence',
    description: evidence
  })
  console.log(`\n===== ISSUE 12164 EVIDENCE =====\n${evidence}\n===== END =====\n`)

  // The grid must not have resized between emit and read, or a wrap artefact
  // would masquerade as duplication.
  expect(gridAtRead).toEqual(gridAtEmit)

  for (const item of CASES) {
    const reading = bufferReadings.find((entry) => entry.id === item.id)
    expect(reading, `no buffer reading for ${item.id}`).toBeTruthy()
    expect(reading?.row, `payload ${item.id} was not found in the viewport`).not.toBeNull()
    // Boundary 1: the data model.
    expect(reading?.translateToString, `buffer text for ${item.id}`).toBe(item.text)
    // Boundary 1 again, via the copy path — xterm resolves getSelection()
    // through the same buffer, so this cannot disagree with the line above.
    expect(reading?.selectionText, `selection text for ${item.id}`).toBe(item.text)

    // Boundary 2: the painted canvas. Doubling would roughly double the ink.
    const painted = canvas.readings.find((entry) => entry.id === item.id)
    expect(painted, `no canvas reading for ${item.id}`).toBeTruthy()
    expect(painted?.inkExtentColumns, `canvas ink extent for ${item.id}`).toBeLessThanOrEqual(
      item.expectedColumns
    )
    expect(painted?.inkExtentColumns, `canvas ink extent for ${item.id}`).toBeGreaterThan(
      item.expectedColumns - 4
    )
  }
  // The DOM arm is only meaningful if the pane actually left WebGL. The WebGL arm
  // needs a GPU that headless CI does not have, and xterm silently falls back to
  // DOM rather than failing — so skip it there instead of asserting, which would
  // otherwise report a missing GPU as a Korean rendering defect.
  if (renderer === 'webgl' && canvas.renderer !== 'webgl') {
    test.skip(true, `no WebGL renderer available (active: ${canvas.renderer})`)
  }
  expect(canvas.renderer, 'requested renderer was not the active renderer').toBe(renderer)
}
