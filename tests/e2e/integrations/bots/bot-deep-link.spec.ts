// "Open in Orca" on a bot thread: orca://bot/… selects the chat tab running that conversation.
import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { buildFakeAgentCommandOverride } from '../../agents/session-fixtures/fake-agent-command-override'
import { waitForActiveWorktree, waitForSessionReady } from '../../desktop/renderer-probes/store'
import {
  SUPPORTED,
  createChatOnHost,
  test
} from '../../agents/session-fixtures/structured-claude-stub'
import type { ExternalConversationLink } from '../../../../src/shared/connectors/external-conversation-link'
import { structuredAgentSessionStatusPaneKey } from '../../../../src/shared/agent-session/view/structured-agent-session-tab'

test.skip(!SUPPORTED, 'the Claude stub wrapper is POSIX-only')

async function chatTabId(page: Page, worktreeId: string, sessionId: string): Promise<string> {
  let tabId: string | undefined
  await expect
    .poll(
      async () => {
        tabId = await page.evaluate(
          ({ wt, session }) =>
            (window.__store?.getState().unifiedTabsByWorktree[wt] ?? []).find(
              (tab) => tab.contentType === 'agent-session' && tab.entityId === session
            )?.id,
          { wt: worktreeId, session: sessionId }
        )
        return tabId
      },
      { timeout: 30_000 }
    )
    .toBeTruthy()
  return tabId!
}

/** The tab shown in the workspace's focused group. */
function activeTab(page: Page, worktreeId: string): Promise<string | null> {
  return page.evaluate((wt) => {
    const state = window.__store?.getState()
    const groupId = state?.activeGroupIdByWorktree[wt]
    return state?.groupsByWorktree[wt]?.find((group) => group.id === groupId)?.activeTabId ?? null
  }, worktreeId)
}

test('a bot link selects its conversation’s chat tab, and an unknown one says so', async ({
  electronApp,
  orcaPage: page,
  claudeStub
}) => {
  // One app launch, a chat start and a few link round trips.
  test.setTimeout(120_000)
  const openUrl = (url: string) =>
    electronApp.evaluate(({ app }, url) => {
      app.emit('open-url', { preventDefault() {} }, url)
    }, url)
  await waitForSessionReady(page)
  const worktreeId = await waitForActiveWorktree(page)
  await page.evaluate(async (command) => {
    await window.__store?.getState().updateSettings({
      defaultTuiAgent: 'claude',
      agentCmdOverrides: { claude: command }
    })
  }, buildFakeAgentCommandOverride(claudeStub.command))
  const sessionId = await createChatOnHost(page, worktreeId)
  const conversationTabId = await chatTabId(page, worktreeId, sessionId)
  // The link a bot's delivery writes when its chat takes a thread.
  const link: ExternalConversationLink = {
    source: 'slack',
    externalId: 'T1:C1:1',
    sessionId,
    agent: 'claude',
    paneKey: structuredAgentSessionStatusPaneKey(sessionId),
    bot: { kind: 'bot', botId: 'bot_1' },
    createdAt: Date.now()
  }
  await page.evaluate(
    ({ wt, link }) =>
      window.api.worktrees.updateMeta({
        worktreeId: wt,
        updates: { externalConversations: [link] }
      }),
    { wt: worktreeId, link }
  )

  // Move away so the link has something to do.
  await page.evaluate(
    (wt) => window.__store?.getState().createTab(wt, undefined, undefined, { activate: true }),
    worktreeId
  )
  await expect.poll(() => activeTab(page, worktreeId)).not.toBe(conversationTabId)

  await openUrl('orca://bot/bot_1?conversation=slack%3AT1%3AC1%3A1')
  await expect.poll(() => activeTab(page, worktreeId)).toBe(conversationTabId)

  await openUrl('orca://bot/bot_1?conversation=slack%3AT1%3AC1%3A2')
  await expect(page.getByText("That conversation isn't open on this computer.")).toBeVisible()
  expect(await activeTab(page, worktreeId)).toBe(conversationTabId)
})
