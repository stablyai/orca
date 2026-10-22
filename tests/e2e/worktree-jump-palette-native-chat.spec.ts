import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { expect } from './helpers/orca-app'
import { SUPPORTED, test } from './helpers/structured-claude-stub'
import { buildFakeAgentCommandOverride } from './helpers/fake-agent-command-override'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  createStructuredAgentSessionId,
  structuredAgentSessionCreateParams
} from '../../src/shared/structured-agent-session-create'
import { structuredAgentSessionPaneKey } from '../../src/shared/structured-agent-session-projection'

type NativeChat = {
  tabId: string
  sessionId: string
  providerSessionId: string
  worktreeId: string
  label: string
  transcript: string
}

async function seedNativeChats(
  page: Page,
  app: ElectronApplication,
  repoPath: string,
  command: string
): Promise<NativeChat[]> {
  await waitForSessionReady(page)
  const worktreeId = await waitForActiveWorktree(page)
  const home = await app.evaluate(({ app }) => app.getPath('home'))
  const directory = path.join(home, '.claude', 'projects', '-cmd-j-native-chat')
  mkdirSync(directory, { recursive: true })
  await page.evaluate(async (command) => {
    await window.__store?.getState().updateSettingsOrThrow({
      uiLanguage: 'en',
      experimentalNativeChat: true,
      nativeChatAutoName: false,
      agentCmdOverrides: { claude: command }
    })
  }, buildFakeAgentCommandOverride(command))

  const chats: NativeChat[] = []
  for (const [label, version] of [
    ['Release investigation', 'v1.4.217'],
    ['Previous release discussion', 'v1.4.216']
  ]) {
    const providerSessionId = randomUUID()
    const sessionId = createStructuredAgentSessionId('claude', randomUUID)
    const transcript = `The resolved release is ${version}; keep this exact version in the report.`
    writeFileSync(
      path.join(directory, `${providerSessionId}.jsonl`),
      `${[
        { role: 'user', text: 'Which release resolves the reported problem?' },
        { role: 'assistant', text: transcript }
      ]
        .map(({ role, text }) =>
          JSON.stringify({
            type: role,
            uuid: randomUUID(),
            sessionId: providerSessionId,
            cwd: repoPath,
            timestamp: new Date().toISOString(),
            message: { role, content: [{ type: 'text', text }] }
          })
        )
        .join('\n')}\n`
    )
    const params = structuredAgentSessionCreateParams({
      sessionId,
      worktree: `id:${worktreeId}`,
      agent: 'claude',
      resumeFrom: { providerSessionId },
      randomUuid: randomUUID
    })
    const reply = await page.evaluate(
      (params) => window.api.runtime.call({ method: 'agentSession.create', params }),
      params
    )
    expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true })
    await expect
      .poll(() =>
        page.evaluate(
          ({ worktreeId, sessionId }) =>
            window.__store
              ?.getState()
              .unifiedTabsByWorktree[worktreeId]?.some(
                (tab) => tab.contentType === 'agent-session' && tab.entityId === sessionId
              ) ?? false,
          { worktreeId, sessionId }
        )
      )
      .toBe(true)
    const tabId = await page.evaluate(
      ({ worktreeId, sessionId, label }) => {
        const state = window.__store!.getState()
        const tab = state.unifiedTabsByWorktree[worktreeId]?.find(
          (candidate) =>
            candidate.contentType === 'agent-session' && candidate.entityId === sessionId
        )
        if (!tab) {
          throw new Error('Created native chat tab is missing')
        }
        state.setTabCustomLabel(tab.id, label)
        return tab.id
      },
      { worktreeId, sessionId, label }
    )
    chats.push({ tabId, sessionId, providerSessionId, worktreeId, label, transcript })
  }
  await page.evaluate(async () => {
    await window.__store
      ?.getState()
      .updateSettingsOrThrow({ aiVaultSearch: { enabled: true, historyDays: null } })
  })
  await expect
    .poll(
      () =>
        page.evaluate(async () => (await window.api.aiVault.searchStatus('local')).filesIndexed),
      { timeout: 30_000 }
    )
    .toBeGreaterThanOrEqual(chats.length)
  return chats
}

async function captureEvidence(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.getByRole('dialog').evaluateAll(async (dialogs) => {
    const animations = dialogs.flatMap((dialog) => dialog.getAnimations({ subtree: true }))
    await Promise.allSettled(
      animations
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished)
    )
  })
  const cdp = await page.context().newCDPSession(page)
  try {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const screenshotPath = testInfo.outputPath(`${name}.png`)
    writeFileSync(screenshotPath, Buffer.from(data, 'base64'))
    await testInfo.attach(name, { path: screenshotPath, contentType: 'image/png' })
    await testInfo.attach(`${name}-dom`, {
      body: await page.locator('body').innerText(),
      contentType: 'text/plain'
    })
  } finally {
    await cdp.detach()
  }
}

test.describe('Cmd+J native chat', () => {
  test.skip(!SUPPORTED, 'the existing Claude protocol fixture uses a POSIX wrapper')

  test('searches a numeric version in the real transcript index and activates the matching chat', async ({
    orcaPage: page,
    electronApp,
    seededRepoPath,
    claudeStub
  }, testInfo) => {
    const [target, other] = await seedNativeChats(
      page,
      electronApp,
      seededRepoPath,
      claudeStub.command
    )
    const search = await page.evaluate(() =>
      window.api.aiVault.searchSessions({ query: '217', includeOriginalExcerpt: true }, 'local')
    )
    expect(search.kind).toBe('results')
    if (search.kind !== 'results') {
      throw new Error(`Search unavailable: ${JSON.stringify(search)}`)
    }
    expect(search.hits.map((hit) => hit.sessionId)).toEqual([target.providerSessionId])
    expect(search.hits[0]?.evidence?.originalExcerpt?.text).toContain('v1.4.217')
    await testInfo.attach('real-index-response', {
      body: JSON.stringify(search, null, 2),
      contentType: 'application/json'
    })

    await page.locator(`[data-testid="sortable-tab"][data-tab-id="${other.tabId}"]`).click()
    const chat = page.locator('[data-native-chat-root="true"]:visible')
    await expect(chat.getByText(other.transcript, { exact: true })).toBeVisible()
    await page.evaluate(() => window.__store!.getState().openModal('worktree-palette'))
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('combobox').fill('217')
    const targetRow = dialog.locator('[cmdk-item]').filter({ hasText: target.label })
    await expect(targetRow).toHaveCount(1)
    await expect(targetRow).toContainText('v1.4.217')
    await expect(
      targetRow
        .locator('[data-slot="palette-open-tab-transcript-snippet"]')
        .getByText('217', { exact: true })
    ).toBeVisible()
    await expect(dialog.locator('[cmdk-item]').filter({ hasText: other.label })).toHaveCount(0)
    await captureEvidence(page, testInfo, 'native-chat-version-search')

    await targetRow.click()
    await expect(dialog).toHaveCount(0)
    await expect(chat.getByText(target.transcript, { exact: true })).toBeVisible()
    await expect(chat.getByText(other.transcript, { exact: true })).toHaveCount(0)
    await expect(
      page.locator(`[data-testid="sortable-tab"][data-tab-id="${target.tabId}"]`)
    ).toHaveAttribute('data-active', 'true')
    expect(
      await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible())
      )
    ).toBe(false)
    await captureEvidence(page, testInfo, 'native-chat-correct-activation')
  })

  test('keeps current working and permission chats actionable and shows background unread completions', async ({
    orcaPage: page,
    electronApp,
    seededRepoPath,
    claudeStub
  }, testInfo) => {
    const [target, other] = await seedNativeChats(
      page,
      electronApp,
      seededRepoPath,
      claudeStub.command
    )
    await page.locator(`[data-testid="sortable-tab"][data-tab-id="${target.tabId}"]`).click()
    await expect(
      page.locator('[data-native-chat-root="true"]:visible').getByText(target.transcript, {
        exact: true
      })
    ).toBeVisible()
    const paneKey = structuredAgentSessionPaneKey(target.tabId, target.sessionId)
    for (const [state, label] of [
      ['working', 'Working'],
      ['waiting', 'Needs permission']
    ] as const) {
      const applyStatus = () =>
        page.evaluate(
          ({ target, paneKey, state }) => {
            const store = window.__store!
            const current = store.getState()
            store.setState({
              agentStatusByPaneKey: {
                ...current.agentStatusByPaneKey,
                [paneKey]: {
                  state,
                  agentType: 'claude',
                  paneKey,
                  tabId: target.tabId,
                  worktreeId: target.worktreeId,
                  prompt: 'Release investigation',
                  updatedAt: Date.now(),
                  stateStartedAt: Date.now(),
                  stateHistory: [],
                  providerSession: { key: 'session_id', id: target.providerSessionId }
                }
              },
              unreadAgentCompletionPanes: {},
              unreadTerminalTabs: {},
              agentStatusEpoch: current.agentStatusEpoch + 1
            })
          },
          { target, paneKey, state }
        )
      await applyStatus()
      await page.evaluate(() => window.__store!.getState().openModal('worktree-palette'))
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByRole('combobox')).toHaveValue('')
      // Opening attaches host feeds; install the UI status after their initial projection too.
      await applyStatus()
      await expect(dialog.getByText('Recent Chats & Terminals', { exact: true })).toBeVisible()
      const currentRow = dialog.locator('[cmdk-item]').filter({ hasText: target.label })
      await expect(currentRow).toHaveCount(1)
      await expect(currentRow.getByText('Current Tab', { exact: true })).toBeVisible()
      await expect(currentRow.getByText(label, { exact: true })).toBeAttached()
      await expect(currentRow.locator('[data-agent-icon="claude"]')).toBeVisible()
      await expect(
        currentRow.locator(`[aria-label="${state === 'working' ? 'Working' : 'Needs attention'}"]`)
      ).toBeVisible()
      await expect(dialog.locator('[cmdk-item]').filter({ hasText: other.label })).toBeVisible()
      await captureEvidence(page, testInfo, `native-chat-recents-${state}`)
      await currentRow.click()
      await expect(dialog).toHaveCount(0)
      await expect(
        page.locator(`[data-testid="sortable-tab"][data-tab-id="${target.tabId}"]`)
      ).toHaveAttribute('data-active', 'true')
      await expect(
        page.locator('[data-native-chat-root="true"]:visible').getByText(target.transcript, {
          exact: true
        })
      ).toBeVisible()
    }

    await page.locator(`[data-testid="sortable-tab"][data-tab-id="${other.tabId}"]`).click()
    await expect(
      page.locator('[data-native-chat-root="true"]:visible').getByText(other.transcript, {
        exact: true
      })
    ).toBeVisible()
    await page.evaluate((paneKey) => {
      const store = window.__store!
      const current = store.getState()
      const entry = current.agentStatusByPaneKey[paneKey]
      if (!entry) {
        throw new Error('Native chat status projection is missing')
      }
      store.setState({
        agentStatusByPaneKey: {
          ...current.agentStatusByPaneKey,
          [paneKey]: { ...entry, state: 'done', updatedAt: Date.now() }
        },
        unreadAgentCompletionPanes: { [paneKey]: 'agent-completion' },
        unreadTerminalTabs: {},
        agentStatusEpoch: current.agentStatusEpoch + 1
      })
      store.getState().openModal('worktree-palette')
    }, paneKey)
    const dialog = page.getByRole('dialog')
    const unreadRow = dialog.locator('[cmdk-item]').filter({ hasText: target.label })
    await expect(unreadRow.getByText('Unread agent completion', { exact: true })).toBeAttached()
    await expect(unreadRow.getByText('Current Tab', { exact: true })).toHaveCount(0)
    await expect(unreadRow.locator('[data-agent-icon="claude"]')).toBeVisible()
    await captureEvidence(page, testInfo, 'native-chat-background-unread')
    await unreadRow.click()
    await expect(dialog).toHaveCount(0)
    await expect(
      page.locator('[data-native-chat-root="true"]:visible').getByText(target.transcript, {
        exact: true
      })
    ).toBeVisible()
  })
})
