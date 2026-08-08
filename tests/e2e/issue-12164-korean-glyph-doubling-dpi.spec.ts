import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { nodeTerminalCommand } from './terminal-node-command'
import {
  installPaneLookup,
  readBuffer,
  readCanvas,
  waitForStableGrid,
  type PayloadCase
} from './issue-12164-korean-glyph-doubling-probe'

// Issue #12164's last unexplored branch: FRACTIONAL DISPLAY SCALING.
//
// The paint is already proven clean at scale 1 on both the DOM and WebGL renderers, and ConPTY
// delivery, the buffer and the serialize path are all clean too. What was never tested is whether
// a non-integer device scale factor doubles wide glyphs — the reporter's `프프로로젝젝트트` is
// exactly what a half-pixel cell boundary could produce on a 2-column glyph.
//
// Prior attempts at this branch were BLOCKED, and correctly so: they proposed mutating the Windows
// display scale on a remote physical machine with no console recovery. `--force-device-scale-factor`
// reaches the same renderer state PER PROCESS, so nothing outside this Electron instance changes and
// there is nothing to restore.
const KOREAN = '프로젝트 브랜딩 이름 확정'
const CASES: PayloadCase[] = [
  { id: 'korean', text: KOREAN, expectedColumns: 25 },
  { id: 'ascii', text: 'project branding name', expectedColumns: 21 },
  { id: 'chinese', text: '项目品牌名称确定', expectedColumns: 16 }
]
const DONE_MARKER = 'ISSUE_12164_EMIT_DONE'
const EMIT_FIXTURE_PATH = path.join(process.cwd(), 'tests/e2e/fixtures/issue-12164-korean-emit.cjs')

// 1.25 and 1.5 are the two fractional steps Windows offers below 2x, and the ones the blocked
// preflights named.
const SCALE = process.env.ORCA_E2E_FORCE_SCALE ?? '1.25'

test.use({ orcaAppExtraArgs: [`--force-device-scale-factor=${SCALE}`] })

test.describe('issue #12164 Korean glyph doubling under fractional scaling', () => {
  test('wide glyphs do not double at a non-integer device scale factor', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    await installPaneLookup(orcaPage)
    await waitForStableGrid(orcaPage)

    // Self-certification: the arm is worthless if the flag did not take.
    const dpr = await orcaPage.evaluate(() => window.devicePixelRatio)
    console.log(`[12164-dpi] requested=${SCALE} devicePixelRatio=${dpr}`)
    expect(dpr, 'forced device scale factor did not take').toBeCloseTo(Number(SCALE), 2)

    await execInTerminal(orcaPage, ptyId, nodeTerminalCommand([EMIT_FIXTURE_PATH]))
    await waitForTerminalOutput(orcaPage, DONE_MARKER, 30_000)
    await orcaPage.waitForTimeout(750)

    const bufferReadings = await readBuffer(orcaPage, CASES)
    const locatedRows = bufferReadings
      .filter((reading) => reading.row !== null)
      .map((reading) => ({ id: reading.id, row: reading.row as number }))
    const canvas = await readCanvas(orcaPage, locatedRows)
    console.log(
      `[12164-dpi] renderer=${canvas.renderer} readings=${JSON.stringify(canvas.readings)}`
    )

    for (const item of CASES) {
      const reading = bufferReadings.find((entry) => entry.id === item.id)
      expect(reading?.translateToString, `buffer text for ${item.id}`).toBe(item.text)
      // The reported symptom is in the paint, so ink extent is the load-bearing assertion:
      // doubling would roughly double it.
      const painted = canvas.readings.find((entry) => entry.id === item.id)
      expect(painted?.inkExtentColumns, `canvas ink for ${item.id}`).toBeLessThanOrEqual(
        item.expectedColumns
      )
      expect(painted?.inkExtentColumns, `canvas ink for ${item.id}`).toBeGreaterThan(
        item.expectedColumns - 4
      )
    }
  })
})
