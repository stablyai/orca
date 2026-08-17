import { execFileSync } from 'node:child_process'
import { expect, test } from './helpers/orca-app'
import {
  createStockHerdrXdgHome,
  openHerdrProjectTerminal,
  removeStockHerdrXdgHome,
  resolvePinnedHerdrBinary,
  selectHerdrInSettings,
  stockHerdrLaunchEnv
} from './helpers/herdr-terminal-runtime'
import { waitForSessionReady } from './helpers/store'
import { SORTABLE_TAB } from './helpers/terminal-tab-menu'
import { waitForActivePanePtyId } from './helpers/terminal'

test.describe.configure({ mode: 'serial' })

const stockBinary = resolvePinnedHerdrBinary()
const stockXdgHome = stockBinary ? createStockHerdrXdgHome() : ''

test.skip(
  process.platform === 'win32' || !stockBinary,
  'pinned stock herdr binary is unavailable on this host'
)

test.use({
  seedTestRepo: false,
  orcaAppExtraEnv: stockBinary ? stockHerdrLaunchEnv(stockBinary, stockXdgHome) : {}
})

function stopStockHerdrSession(): void {
  if (!stockBinary || !stockXdgHome) {
    return
  }
  try {
    execFileSync(stockBinary, ['session', 'stop', 'orca', '--json'], {
      env: { ...process.env, XDG_CONFIG_HOME: stockXdgHome, XDG_RUNTIME_DIR: stockXdgHome },
      timeout: 10_000,
      stdio: 'ignore'
    })
  } catch {
    // Session never started.
  }
}

test.afterEach(() => {
  stopStockHerdrSession()
})

test.afterAll(() => {
  stopStockHerdrSession()
  if (stockXdgHome) {
    removeStockHerdrXdgHome(stockXdgHome)
  }
})

test('settings selects stock Herdr and opens a bound herdr terminal', async ({
  orcaPage,
  testRepoPath
}) => {
  await waitForSessionReady(orcaPage)
  await selectHerdrInSettings(orcaPage, {
    binaryPath: stockBinary ?? undefined
  })
  await openHerdrProjectTerminal(orcaPage, testRepoPath)
  await expect(orcaPage.locator(SORTABLE_TAB).first()).toBeVisible({ timeout: 30_000 })
  const ptyId = await waitForActivePanePtyId(orcaPage, 30_000)
  expect(ptyId.startsWith('herdr:')).toBe(true)
})
