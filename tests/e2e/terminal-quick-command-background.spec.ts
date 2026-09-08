import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { stageNodeScriptForTerminal } from './helpers/run-node-script-in-terminal'
import { registerTerminalPaneMountReadiness } from './helpers/terminal-pane-mount-readiness'
import { waitForTerminalOutput } from './helpers/terminal'

test.use({ minimumSeededWorktreeCount: 1 })

test.describe('Background Quick Commands', () => {
  registerTerminalPaneMountReadiness()

  test('executes before its tab is selected and leaves output available for inspection', async ({
    orcaPage
  }, testInfo) => {
    const marker = `BACKGROUND_COMPLETED_${randomUUID()}`
    const proofPath = path.join(os.tmpdir(), `orca-background-proof-${randomUUID()}.txt`)
    const staged = stageNodeScriptForTerminal(
      `require('node:fs').writeFileSync(${JSON.stringify(proofPath)}, ${JSON.stringify(marker)}); console.log(${JSON.stringify(marker)})`
    )
    const label = 'Background verification'
    const originalTab = orcaPage.locator('[data-testid="sortable-tab"][data-active="true"]')
    const originalId = await originalTab.getAttribute('data-tab-id')
    expect(originalId).toBeTruthy()
    const tabsBefore = await orcaPage.getByTestId('sortable-tab').count()

    try {
      await orcaPage.evaluate(
        async ({ command, label }) => {
          await window.__store!.getState().updateSettings({
            terminalQuickCommands: [
              {
                id: 'e2e-background',
                label,
                scope: { type: 'global' },
                action: 'terminal-command',
                command,
                appendEnter: false,
                openInBackground: true
              }
            ]
          })
        },
        { command: staged.command, label }
      )
      const button = orcaPage.getByRole('button', { name: `Run quick command: ${label}` })
      await expect(button).toBeVisible()
      await orcaPage.screenshot({ path: testInfo.outputPath('before.png') })
      await button.click()
      await expect(orcaPage.getByTestId('sortable-tab')).toHaveCount(tabsBefore + 1)
      // Why: a filesystem side effect proves that the hidden terminal actually ran before inspection.
      await expect.poll(() => existsSync(proofPath), { timeout: 30_000 }).toBe(true)
      expect(readFileSync(proofPath, 'utf8')).toBe(marker)
      await expect(orcaPage.locator(`[data-tab-id="${originalId}"]`)).toHaveAttribute(
        'data-active',
        'true'
      )
      const backgroundTab = orcaPage.getByTestId('sortable-tab').filter({ hasText: label })
      await expect(backgroundTab).toHaveAttribute('data-active', 'false')
      await orcaPage.screenshot({ path: testInfo.outputPath('background-completed.png') })
      await backgroundTab.click()
      await expect(backgroundTab).toHaveAttribute('data-active', 'true')
      await waitForTerminalOutput(orcaPage, marker)
      await orcaPage.screenshot({ path: testInfo.outputPath('background-output.png') })
    } finally {
      staged.cleanup()
      rmSync(proofPath, { force: true })
    }
  })
})
