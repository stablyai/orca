import { writeFile } from 'node:fs/promises'
import { buildShellCommandFromArgv } from '../../src/shared/tui-agent-startup-shell'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

test('OMP spaced-colon title renders working and clears on idle', async ({
  orcaPage
}, testInfo) => {
  test.skip(
    process.platform === 'win32',
    'POSIX title replay; Windows formatter bytes have separate coverage'
  )
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  const ptyId = await waitForActivePanePtyId(orcaPage)
  const script = testInfo.outputPath('title-replay.cjs')
  await writeFile(
    script,
    `
process.stdout.write('\\x1b]0;OMP : Image review\\x07')
process.stdin.on('data', () => process.stdout.write('\\x1b]0;OMP > Image review\\x07'))
`
  )
  await execInTerminal(
    orcaPage,
    ptyId,
    buildShellCommandFromArgv([process.execPath, script], 'posix')
  )
  const working = orcaPage.locator('[aria-label="Working"]')
  await expect(working.first()).toBeVisible({ timeout: 15000 })
  await orcaPage.screenshot({ path: testInfo.outputPath('omp-title-working.png') })
  await sendToTerminal(orcaPage, ptyId, '\r')
  await expect(working).toHaveCount(0)
  await orcaPage.screenshot({ path: testInfo.outputPath('omp-title-idle.png') })
})
