/**
 * A deliberate in-agent `/rename` has to reach the painted tab label even after
 * Orca has generated a title from the opening prompt, while the agent's own
 * auto-generated summaries keep losing to that generated title.
 *
 * The rename and the summary arrive on the same OSC title channel, so the proof
 * drives real OSC frames into the pane and reads the label the tab strip paints
 * — the resolvers alone cannot show which name the user ends up seeing.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  sendToTerminal,
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { waitForPtyShellEcho } from './terminal-pty-readiness'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const AGENT_PROMPT = 'What is 2+2? Answer in one word.'
const GENERATED_TITLE = 'What is 2 2'
const AUTO_SUMMARY_TITLE = 'Answer simple arithmetic question'
const RENAMED_TITLE = 'billing-fix'

async function writeClaudeTranscript(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-e2e-rename-'))
  const transcriptPath = join(root, 'session.jsonl')
  // Records copied verbatim from a real Claude session that answered one prompt
  // and was then renamed with `/rename billing-fix`.
  await writeFile(
    transcriptPath,
    `${[
      JSON.stringify({ type: 'user', message: { role: 'user', content: AGENT_PROMPT } }),
      JSON.stringify({ type: 'ai-title', aiTitle: AUTO_SUMMARY_TITLE, sessionId: 'e2e-session' }),
      JSON.stringify({ type: 'custom-title', customTitle: RENAMED_TITLE, sessionId: 'e2e-session' })
    ].join('\n')}\n`
  )
  return transcriptPath
}

async function emitAgentOscTitle(page: Page, ptyId: string, title: string): Promise<void> {
  // Why: the sleep holds the frame. A returning shell prompt repaints its own
  // cwd title immediately, which a live agent never does.
  await sendToTerminal(page, ptyId, `printf '\\033]0;${title}\\007'; sleep 20\r`)
}

async function interruptTerminal(page: Page, ptyId: string): Promise<void> {
  await sendToTerminal(page, ptyId, '\u0003')
}

async function captureTabLabelProof(
  page: Page,
  testInfo: { outputPath: (name: string) => string },
  name: string
): Promise<void> {
  await page
    .locator('[data-testid="sortable-tab"][data-active="true"]')
    .first()
    .screenshot({ path: testInfo.outputPath(`tab-${name}.png`) })
  await page.screenshot({ path: testInfo.outputPath(`window-${name}.png`) })
}

async function paintedActiveTabTitle(page: Page): Promise<string | null> {
  return page
    .locator('[data-testid="sortable-tab"][data-active="true"]')
    .first()
    .getAttribute('data-tab-title')
}

test.describe('Agent /rename vs the generated tab title', () => {
  test('a mid-session rename wins the tab label while auto summaries do not', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    await waitForPtyShellEcho(orcaPage, ptyId, 30_000)
    const { paneKey } = await waitForActivePaneHookDescriptor(orcaPage)
    const tabId = paneKey.split(':')[0]

    const transcriptPath = await writeClaudeTranscript()
    await orcaPage.evaluate(async () => {
      await window.__store?.getState().updateSettings({ tabAutoGenerateTitle: true })
    })
    await orcaPage.evaluate(
      ({ paneKey, transcriptPath, prompt }) => {
        const store = window.__store
        if (!store) {
          throw new Error('window.__store is unavailable')
        }
        const state = store.getState()
        state.setAgentStatus(paneKey, { state: 'working', prompt, agentType: 'claude' })
        state.setGeneratedTabTitleFromAgentPrompt(paneKey, prompt)
        // Why: the transcript path normally arrives on an agent hook report. The
        // e2e app runs no real Claude, so seed the shape the hook writes.
        store.setState({
          agentStatusByPaneKey: {
            ...store.getState().agentStatusByPaneKey,
            [paneKey]: {
              ...store.getState().agentStatusByPaneKey[paneKey],
              providerSession: { key: 'session_id', id: 'e2e-session', transcriptPath }
            }
          }
        })
      },
      { paneKey, transcriptPath, prompt: AGENT_PROMPT }
    )

    await expect
      .poll(() => paintedActiveTabTitle(orcaPage), {
        timeout: 15_000,
        message: 'the opening prompt did not produce a generated tab title'
      })
      .toBe(GENERATED_TITLE)

    // The agent's own summary of the conversation must not displace it.
    await emitAgentOscTitle(orcaPage, ptyId, `✳ ${AUTO_SUMMARY_TITLE}`)
    await expect
      .poll(
        () =>
          orcaPage.evaluate(
            (tabId) =>
              Object.values(window.__store?.getState().tabsByWorktree ?? {})
                .flat()
                .find((tab) => tab.id === tabId)?.title ?? '',
            tabId
          ),
        { timeout: 15_000, message: 'the auto-summary OSC title never reached the store' }
      )
      .toContain(AUTO_SUMMARY_TITLE)
    expect(await paintedActiveTabTitle(orcaPage)).toBe(GENERATED_TITLE)
    await captureTabLabelProof(orcaPage, testInfo, 'auto-summary')

    // The deliberate `/rename` arrives on the same channel and must win.
    await interruptTerminal(orcaPage, ptyId)
    await emitAgentOscTitle(orcaPage, ptyId, `✳ ${RENAMED_TITLE}`)
    await expect
      .poll(
        () =>
          orcaPage.evaluate(
            (tabId) =>
              Object.values(window.__store?.getState().tabsByWorktree ?? {})
                .flat()
                .find((tab) => tab.id === tabId)?.title ?? '',
            tabId
          ),
        { timeout: 15_000, message: 'the rename OSC title never reached the store' }
      )
      .toContain(RENAMED_TITLE)
    // Why: the transcript scan the rename triggers is asynchronous, so settle
    // before capturing — this is the frame the before/after proof compares.
    await orcaPage.waitForTimeout(2_000)
    await captureTabLabelProof(orcaPage, testInfo, 'after-rename')
    await expect
      .poll(() => paintedActiveTabTitle(orcaPage), {
        timeout: 15_000,
        message: 'the deliberate /rename never reached the painted tab label'
      })
      .toBe(`✳ ${RENAMED_TITLE}`)
  })
})
