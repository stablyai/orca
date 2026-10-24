import type { Page } from '@stablyai/playwright-test'
import { expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { buildFakeAgentCommandOverride } from './helpers/fake-agent-command-override'
import { SUPPORTED, test } from './helpers/structured-claude-stub'
import type { Automation, AutomationRun } from '../../src/shared/automations-types'

function readChatTabs(page: Page, worktreeId: string): Promise<{ id: string; entityId: string }[]> {
  return page.evaluate(
    (wt) =>
      (window.__store?.getState().unifiedTabsByWorktree[wt] ?? [])
        .filter((tab) => tab.contentType === 'agent-session')
        .map((tab) => ({ id: tab.id, entityId: tab.entityId })),
    worktreeId
  )
}

test.describe('automation structured chat UI', () => {
  test.skip(!SUPPORTED, 'the Claude stub wrapper is POSIX-only')

  test('runs an automation in a structured chat session, reuses it on the next run, and navigates on View run', async ({
    orcaPage: page,
    claudeStub
  }) => {
    test.setTimeout(120_000)
    await waitForSessionReady(page)
    const worktreeId = await waitForActiveWorktree(page)

    await page.evaluate(async (command) => {
      await window.__store?.getState().updateSettings({
        experimentalNativeChat: true,
        defaultTuiAgent: 'claude',
        agentCmdOverrides: { claude: command }
      })
    }, buildFakeAgentCommandOverride(claudeStub.command))

    const repoId = await page.evaluate((wt) => {
      const state = window.__store?.getState()
      const worktree = state?.allWorktrees().find((entry) => entry.id === wt)
      if (!worktree) {
        throw new Error('Active worktree not found')
      }
      return worktree.repoId
    }, worktreeId)

    const created = await page.evaluate(
      async ({ targetRepoId, targetWorktreeId }) => {
        const response = await window.api.runtime.call({
          method: 'automation.create',
          params: {
            name: 'Daily Chat UI Check',
            prompt: 'Verify the build in structured chat mode.',
            agentId: 'claude',
            repo: targetRepoId,
            workspace: targetWorktreeId,
            workspaceMode: 'existing',
            reuseSession: true,
            timezone: 'UTC',
            rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
            dtstart: Date.now()
          }
        })
        return response
      },
      { targetRepoId: repoId, targetWorktreeId: worktreeId }
    )
    expect(created).toMatchObject({
      ok: true,
      result: {
        automation: expect.objectContaining({
          name: 'Daily Chat UI Check',
          agentId: 'claude'
        })
      }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: verified by the toMatchObject assertion above.
    const automationId = (created as { result: { automation: Automation } }).result.automation.id

    const runNowResponse = await page.evaluate(async (id) => {
      return await window.api.runtime.call({
        method: 'automation.runNow',
        params: { id }
      })
    }, automationId)
    expect(runNowResponse).toMatchObject({ ok: true })

    let firstRun: AutomationRun | undefined
    await expect
      .poll(
        async () => {
          const runsResponse = await page.evaluate(async (id) => {
            return await window.api.runtime.call({
              method: 'automation.runs',
              params: { automationId: id }
            })
          }, automationId)
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reading RPC response envelope in test.
          const runs = (runsResponse as { result?: { runs?: AutomationRun[] } }).result?.runs ?? []
          firstRun = runs[0]
          return firstRun?.status
        },
        { timeout: 45_000, message: 'Expected automation run to complete in structured chat mode' }
      )
      .toBe('completed')

    expect(firstRun).toMatchObject({
      status: 'completed',
      sessionKind: 'structured',
      chatSessionId: expect.any(String),
      terminalPtyId: null,
      outputSnapshot: expect.objectContaining({
        content: 'Stub reply.'
      })
    })

    const chatTabsAfterFirst = await readChatTabs(page, worktreeId)
    expect(chatTabsAfterFirst).toHaveLength(1)
    expect(chatTabsAfterFirst[0]?.entityId).toBe(firstRun?.chatSessionId)

    // Trigger a second run to verify reuseSession reuses the exact same structured chat session
    const secondRunResponse = await page.evaluate(async (id) => {
      return await window.api.runtime.call({
        method: 'automation.runNow',
        params: { id }
      })
    }, automationId)
    expect(secondRunResponse).toMatchObject({ ok: true })

    let secondRun: AutomationRun | undefined
    await expect
      .poll(
        async () => {
          const runsResponse = await page.evaluate(async (id) => {
            return await window.api.runtime.call({
              method: 'automation.runs',
              params: { automationId: id }
            })
          }, automationId)
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reading RPC response envelope in test.
          const runs = (runsResponse as { result?: { runs?: AutomationRun[] } }).result?.runs ?? []
          secondRun = runs.find((entry) => entry.id !== firstRun?.id)
          return secondRun?.status
        },
        { timeout: 45_000, message: 'Expected second automation run to complete on reused session' }
      )
      .toBe('completed')

    expect(secondRun).toMatchObject({
      status: 'completed',
      sessionKind: 'structured',
      chatSessionId: firstRun?.chatSessionId,
      terminalPtyId: null,
      outputSnapshot: expect.objectContaining({
        content: 'Stub reply.'
      })
    })

    const chatTabsAfterSecond = await readChatTabs(page, worktreeId)
    expect(chatTabsAfterSecond).toHaveLength(1)

    // Open Automations page and navigate to the run details to verify UI & "View run" action
    await page.evaluate(
      ({ id, runId }) => {
        const store = window.__store
        if (!store) {
          throw new Error('Store unavailable')
        }
        store.getState().setPendingAutomationRunNavigation({ automationId: id, runId })
        store.getState().openAutomationsPage()
      },
      { id: automationId, runId: secondRun!.id }
    )

    await expect(page.getByText('Stub reply.', { exact: true })).toBeVisible({ timeout: 15_000 })
    const viewRunButton = page.getByRole('button', { name: 'View run' })
    await expect(viewRunButton).toBeVisible()

    await viewRunButton.click()

    await expect
      .poll(
        async () =>
          page.evaluate(() => ({
            activeView: window.__store?.getState().activeView,
            activeTabType: window.__store?.getState().activeTabType
          })),
        { timeout: 15_000 }
      )
      .toEqual({
        activeView: 'terminal',
        activeTabType: 'agent-session'
      })

    // Why: DOM, not store — the store can switch while nothing paints. Selection is stated by the
    // tab strip's own data-active, the run-details page must be gone, and the reply must come from a
    // rendered chat surface, not the page that showed the same text before the click.
    const chatTabId = chatTabsAfterSecond[0]!.id
    await expect(
      page.locator(`[data-testid="sortable-tab"][data-tab-id="${chatTabId}"]`)
    ).toHaveAttribute('data-active', 'true')
    await expect(page.getByRole('button', { name: 'View run' })).toHaveCount(0)
    const chatRoot = page.locator('[data-native-chat-root="true"]:visible').last()
    await expect(chatRoot).toBeVisible({ timeout: 15_000 })
    await expect(chatRoot.getByText('Stub reply.', { exact: true }).first()).toBeVisible({
      timeout: 15_000
    })
  })
})
