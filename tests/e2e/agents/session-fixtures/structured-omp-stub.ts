import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test as base } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import { waitForActiveWorktree, waitForSessionReady } from '../../desktop/renderer-probes/store'
import { buildFakeAgentCommandOverride } from './fake-agent-command-override'
import { createChatOnHost } from './structured-claude-stub'

// Skip Windows until the POSIX stub wrapper has a verified .cmd equivalent.
export const SUPPORTED = process.platform !== 'win32'
const STUB_SCRIPT = path.join(process.cwd(), 'tests', 'e2e', 'fixtures', 'omp-acp-stub.cjs')

export type OmpStub = { command: string; eventsPath: string }
export type OmpStubEvent = {
  kind: string
  method?: string
  sessionId?: string
  text?: string
  filePath?: string
  context?: {
    header?: { id?: string; parentSession?: string }
    messages?: { role: string | null; text: string }[]
    customTypes?: string[]
  }
  params?: { prompt?: { type: string; text?: string }[]; sessionId?: string }
}

export const test = base.extend<{ ompStub: OmpStub }>({
  // oxlint-disable-next-line no-empty-pattern -- Playwright fixture callbacks require object destructuring here.
  ompStub: async ({}, provideFixture) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-structured-omp-'))
    const command = path.join(dir, 'omp')
    const eventsPath = path.join(dir, 'events.jsonl')
    const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`
    writeFileSync(
      command,
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(STUB_SCRIPT)} ${quote(eventsPath)} "$@"\n`
    )
    chmodSync(command, 0o755)
    await provideFixture({ command, eventsPath })
    rmSync(dir, { recursive: true, force: true })
  }
})

export function readOmpEvents(eventsPath: string): OmpStubEvent[] {
  try {
    return readFileSync(eventsPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as OmpStubEvent]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

/** Open an OMP native chat driven by the deterministic ACP stub and focus its composer. */
export async function openOmpStubChat(page: Page, ompStub: OmpStub) {
  await waitForSessionReady(page)
  const worktreeId = await waitForActiveWorktree(page)
  await page.evaluate(
    async ({ command }) => {
      await window.__store?.getState().updateSettings({
        uiLanguage: 'en',
        nativeChatProviders: { omp: true },
        defaultTuiAgent: 'omp',
        agentCmdOverrides: { omp: command }
      })
    },
    { command: buildFakeAgentCommandOverride(ompStub.command) }
  )
  const sessionId = await createChatOnHost(page, worktreeId, 'omp')
  const readTabId = () =>
    page.evaluate(
      ({ worktreeId, sessionId }) =>
        window.__store
          ?.getState()
          .unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.entityId === sessionId)?.id,
      { worktreeId, sessionId }
    )
  await expect.poll(readTabId, { timeout: 30_000 }).toBeTruthy()
  const tabId = await readTabId()
  if (!tabId) {
    throw new Error('the OMP chat published no tab')
  }
  const tab = page.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`)
  await tab.click()
  const chat = page.locator('[data-native-chat-root="true"]').first()
  const composer = chat.getByRole('textbox')
  await composer.click()
  const send = chat.getByRole('button', { name: 'Send', exact: true })
  // Wait for the explicit English switch before localized labels anchor the actions.
  await expect(send).toBeVisible({ timeout: 30_000 })
  return {
    worktreeId,
    sessionId,
    tabId,
    tab,
    chat,
    composer,
    send,
    stop: chat.locator('[data-native-chat-critical-action="stop"]')
  }
}
