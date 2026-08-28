import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { stageNodeScriptForTerminal } from './helpers/run-node-script-in-terminal'
import { registerTerminalPaneMountReadiness } from './helpers/terminal-pane-mount-readiness'
import { focusActiveTerminalInput } from './helpers/terminal'

test.describe('Quick Command insertion-only mode', () => {
  registerTerminalPaneMountReadiness()

  test('leaves the command editable without submitting Enter', async ({ orcaPage }) => {
    const resultPath = path.join(os.tmpdir(), `orca-quick-command-edit-${randomUUID()}.txt`)
    const label = `Editable command ${randomUUID()}`
    const staged = stageNodeScriptForTerminal(
      `require('node:fs').writeFileSync(${JSON.stringify(resultPath)}, process.argv[2] || 'missing')`
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
                id: 'e2e-insertion-only',
                label,
                scope: { type: 'global' },
                action: 'terminal-command',
                command,
                appendEnter: false
              }
            ]
          })
        },
        { command: staged.command, label }
      )

      const originalTabId = await orcaPage.evaluate(
        () => window.__store?.getState().activeTabId ?? null
      )
      const quickCommandButton = orcaPage.getByRole('button', {
        name: `Run quick command: ${label}`
      })
      await expect(quickCommandButton).toBeVisible()
      await quickCommandButton.click()

      await expect
        .poll(() => orcaPage.evaluate(() => window.__store?.getState().activeTabId ?? null))
        .not.toBe(originalTabId)
      const quickCommandTabId = await orcaPage.evaluate(
        () => window.__store?.getState().activeTabId ?? null
      )
      expect(quickCommandTabId).not.toBeNull()
      await expect
        .poll(
          () =>
            orcaPage.evaluate((tabId) => {
              const pane = tabId ? window.__paneManagers?.get(tabId)?.getPanes()[0] : undefined
              return pane?.serializeAddon.serialize() ?? ''
            }, quickCommandTabId),
          { message: 'Insertion-only Quick Command text never reached the visible terminal' }
        )
        .toContain(staged.command)

      expect(existsSync(resultPath)).toBe(false)
      await focusActiveTerminalInput(orcaPage)
      await orcaPage.keyboard.type(' edited')
      await orcaPage.keyboard.press('Enter')

      await expect.poll(() => existsSync(resultPath)).toBe(true)
      expect(readFileSync(resultPath, 'utf8')).toBe('edited')
    } finally {
      staged.cleanup()
      rmSync(resultPath, { force: true })
    }
  })
})
