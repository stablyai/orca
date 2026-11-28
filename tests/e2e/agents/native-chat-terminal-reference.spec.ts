import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect } from '@stablyai/playwright-test'
import { ensureTerminalVisible } from '../desktop/renderer-probes/store'
import { test } from '../desktop/electron-fixtures/orca-app'
import { waitForActivePaneHookDescriptor } from '../terminal/input/terminal-active-pane'
import {
  splitActiveTerminalPane,
  waitForActiveTerminalManager
} from '../terminal/layout/terminal-pane-operations'
import {
  claudeTranscriptLines,
  enableNativeChatSetting,
  seedClaudeProviderSession,
  toggleTerminalTabToChatView
} from './session-fixtures/native-chat-transcript-fixture'

test('a terminal reference in Chat opens the exact split pane', async ({ orcaPage }, testInfo) => {
  await orcaPage.setViewportSize({ width: 1440, height: 900 })
  await ensureTerminalVisible(orcaPage, 30_000)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const target = await waitForActivePaneHookDescriptor(orcaPage)
  const [tabId, targetLeafId] = target.paneKey.split(':')

  await splitActiveTerminalPane(orcaPage, 'horizontal')
  await expect
    .poll(async () => (await waitForActivePaneHookDescriptor(orcaPage)).paneKey)
    .not.toBe(target.paneKey)
  const source = await waitForActivePaneHookDescriptor(orcaPage)

  const response = await orcaPage.evaluate(
    (params) => window.api.runtime.call({ method: 'terminal.resolvePane', params }),
    target
  )
  const result = response.ok ? response.result : null
  const terminal =
    result && typeof result === 'object' && 'terminal' in result ? result.terminal : null
  if (
    !terminal ||
    typeof terminal !== 'object' ||
    !('handle' in terminal) ||
    typeof terminal.handle !== 'string'
  ) {
    throw new Error('Could not resolve the target terminal pane')
  }
  const handle = terminal.handle
  expect(handle).toMatch(/^term_/)
  const sessionId = randomUUID()
  const transcriptPath = testInfo.outputPath(join('claude', `${sessionId}.jsonl`))
  mkdirSync(dirname(transcriptPath), { recursive: true })
  writeFileSync(
    transcriptPath,
    claudeTranscriptLines({
      sessionId,
      userText: 'Which terminal should I open?',
      assistantText: `Open terminal \`${handle}\`.`
    })
  )

  await enableNativeChatSetting(orcaPage)
  await seedClaudeProviderSession(orcaPage, { ...source, sessionId, transcriptPath })
  await toggleTerminalTabToChatView(orcaPage, { tabId, worktreeId: source.worktreeId })

  await expect(orcaPage.getByText(handle, { exact: true })).toBeVisible()
  const reference = orcaPage.getByRole('link', { name: handle, exact: true })
  await expect(reference, 'Chat should expose the terminal handle as a link').toBeVisible()
  await reference.click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] })
  await expect(
    orcaPage.locator(`[data-leaf-id="${targetLeafId}"] .xterm-helper-textarea`)
  ).toBeFocused()
})
