import { test, expect } from './helpers/orca-app'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { buildFakeAgentCommandOverride } from './helpers/fake-agent-command-override'
import {
  createChatOnHost,
  SUPPORTED,
  test as structuredTest
} from './helpers/structured-claude-stub'
import {
  ensureTerminalVisible,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { showActivePaneAsNativeChat } from './helpers/native-chat-view'
import { waitForActiveTerminalManager } from './helpers/terminal'

async function prepareWorkspacePair(page: Page) {
  await waitForSessionReady(page)
  const chatWorkspaceId = await waitForActiveWorktree(page)
  const otherWorkspaceId = (await getAllWorktreeIds(page)).find((id) => id !== chatWorkspaceId)
  if (!otherWorkspaceId) {
    throw new Error('A second workspace is required')
  }
  await switchToWorktree(page, otherWorkspaceId)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page)
  await switchToWorktree(page, chatWorkspaceId)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page)
  return { chatWorkspaceId, otherWorkspaceId }
}

async function verifyWorkspaceCycling(
  page: Page,
  testInfo: TestInfo,
  chatWorkspaceId: string,
  otherWorkspaceId: string
) {
  const composer = page.locator('[data-native-chat-root="true"]:visible').getByRole('textbox')
  await expect(composer).toBeFocused()
  const draft = 'Keep this unsent message'
  await composer.fill(draft)
  const modifier = 'ControlOrMeta'
  const chatRow = page.locator(
    `[role="option"][data-worktree-id=${JSON.stringify(chatWorkspaceId)}]`
  )
  const otherRow = page.locator(
    `[role="option"][data-worktree-id=${JSON.stringify(otherWorkspaceId)}]`
  )

  await page.keyboard.press(`${modifier}+Shift+ArrowDown`)
  await expect(otherRow).toHaveAttribute('aria-current', 'page')
  await expect(composer).toBeHidden()
  await page.screenshot({ path: testInfo.outputPath('switched-away-from-chat.png') })

  await page.keyboard.press(`${modifier}+Shift+ArrowUp`)
  await expect(chatRow).toHaveAttribute('aria-current', 'page')
  await expect(composer).toBeFocused()
  await expect(composer).toHaveText(draft)

  await page.keyboard.press(`${modifier}+Shift+ArrowUp`)
  await expect(otherRow).toHaveAttribute('aria-current', 'page')
  await page.keyboard.press(`${modifier}+Shift+ArrowDown`)
  await expect(chatRow).toHaveAttribute('aria-current', 'page')
  await expect(composer).toBeFocused()
  await expect(composer).toHaveText(draft)
  await page.screenshot({ path: testInfo.outputPath('returned-to-chat-with-draft.png') })

  // Rebinding releases the old chord to text editing, including in the chat prompt.
  await page.evaluate(async () => {
    await window.__store
      ?.getState()
      .setKeybindingOverride('worktree.navigateDown', ['Mod+Shift+F12'])
  })
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press(`${modifier}+Shift+ArrowDown`)
  await expect(chatRow).toHaveAttribute('aria-current', 'page')
  await expect
    .poll(() =>
      composer.evaluate((element) => {
        const selection = element.ownerDocument.getSelection()
        return selection?.anchorNode && element.contains(selection.anchorNode)
          ? selection.toString()
          : ''
      })
    )
    .not.toBe('')
  await expect(composer).toHaveText(draft)
  await page.keyboard.press(`${modifier}+Shift+F12`)
  await expect(otherRow).toHaveAttribute('aria-current', 'page')
}

test('workspace shortcuts cycle through terminal-backed chat and keep its unsent draft', async ({
  orcaPage: page
}, testInfo) => {
  const { chatWorkspaceId, otherWorkspaceId } = await prepareWorkspacePair(page)
  await showActivePaneAsNativeChat(page, 'claude', 'Claude')
  await verifyWorkspaceCycling(page, testInfo, chatWorkspaceId, otherWorkspaceId)
})

structuredTest.describe('structured chat workspace shortcuts', () => {
  structuredTest.skip(!SUPPORTED, 'the Claude stub wrapper is POSIX-only')

  structuredTest(
    'keeps its unsent draft and respects remapped shortcuts',
    async ({ orcaPage: page, claudeStub }, testInfo) => {
      const { chatWorkspaceId, otherWorkspaceId } = await prepareWorkspacePair(page)
      await page.evaluate(async (command) => {
        await window.__store?.getState().updateSettings({
          experimentalNativeChat: true,
          agentCmdOverrides: { claude: command }
        })
      }, buildFakeAgentCommandOverride(claudeStub.command))
      const sessionId = await createChatOnHost(page, chatWorkspaceId)
      const readTabId = () =>
        page.evaluate(
          ({ chatWorkspaceId, sessionId }) =>
            window.__store
              ?.getState()
              .unifiedTabsByWorktree[chatWorkspaceId]?.find((tab) => tab.entityId === sessionId)
              ?.id,
          { chatWorkspaceId, sessionId }
        )
      await expect.poll(readTabId, { timeout: 30_000 }).toBeTruthy()
      await page.locator(`[data-testid="sortable-tab"][data-tab-id="${await readTabId()}"]`).click()
      await verifyWorkspaceCycling(page, testInfo, chatWorkspaceId, otherWorkspaceId)
    }
  )
})
