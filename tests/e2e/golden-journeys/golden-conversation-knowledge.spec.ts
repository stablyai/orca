import { expect } from '@stablyai/playwright-test'
import { test } from '../desktop/electron-fixtures/orca-app'
import { waitForSessionReady } from '../desktop/renderer-probes/store'
import {
  KNOWLEDGE_CONCEPT,
  KNOWLEDGE_SOURCE_ID,
  KNOWLEDGE_SOURCE_TITLE,
  seedGoldenConversationKnowledge
} from './golden-conversation-knowledge-data'

test('@golden conversation knowledge fits a long map, wraps Chinese evidence, and locates its source', async ({
  electronApp,
  orcaPage,
  testRepoPath
}, testInfo) => {
  await orcaPage.setViewportSize({ width: 1600, height: 1000 })
  await waitForSessionReady(orcaPage)
  const locations = await electronApp.evaluate(({ app }) => ({
    home: app.getPath('home'),
    userData: app.getPath('userData')
  }))
  seedGoldenConversationKnowledge(locations.userData, locations.home, testRepoPath)
  await orcaPage.evaluate(async () => {
    const state = window.__store?.getState()
    await state?.updateSettings({
      uiLanguage: 'zh',
      conversationKnowledgeEnabled: true,
      conversationKnowledgeEnrichmentEnabled: false,
      conversationKnowledgeEnrichmentAgent: 'codex',
      conversationKnowledgeEnrichmentModel: 'gpt-5'
    })
  })
  await orcaPage.getByRole('button', { name: '对话知识', exact: true }).click()
  const map = orcaPage.getByRole('application', { name: '概念关系' })
  await expect(map.getByRole('button')).toHaveCount(11)
  for (const viewport of [
    { width: 1600, height: 1000 },
    { width: 1280, height: 800 }
  ]) {
    await orcaPage.setViewportSize(viewport)
    await expect
      .poll(() =>
        map.evaluate((element) => {
          const frame = element.getBoundingClientRect()
          const nodes = [...element.querySelectorAll('button')].map((node) =>
            node.getBoundingClientRect()
          )
          const left = Math.min(...nodes.map((node) => node.left)),
            right = Math.max(...nodes.map((node) => node.right))
          const top = Math.min(...nodes.map((node) => node.top)),
            bottom = Math.max(...nodes.map((node) => node.bottom))
          return Math.max(
            Math.abs((left + right - frame.left - frame.right) / 2),
            Math.abs((top + bottom - frame.top - frame.bottom) / 2),
            frame.left - left,
            right - frame.right,
            frame.top - top,
            bottom - frame.bottom
          )
        })
      )
      .toBeLessThan(2)
  }
  await map.getByRole('button', { name: KNOWLEDGE_CONCEPT, exact: true }).click()
  const article = orcaPage
    .locator('article')
    .filter({ has: orcaPage.getByRole('heading', { name: KNOWLEDGE_CONCEPT, exact: true }) })
  await expect(article.locator('li button')).toHaveCount(4)
  const overflow = await article.locator('li button').evaluateAll((buttons) =>
    buttons.some((button) => {
      const box = button.getBoundingClientRect()
      return [...button.querySelectorAll('span')].some((span) => {
        const text = span.getBoundingClientRect()
        return text.bottom > box.bottom + 1 || text.top < box.top - 1 || text.right > box.right + 1
      })
    })
  )
  expect(overflow).toBe(false)
  await testInfo.attach('knowledge-map-and-Chinese-evidence', {
    body: await orcaPage.screenshot(),
    contentType: 'image/png'
  })
  await article.getByRole('button').filter({ hasText: KNOWLEDGE_SOURCE_ID }).click()
  const history = orcaPage.locator('[data-right-sidebar-panel]')
  await expect(history.getByRole('textbox', { name: '搜索会话', exact: true })).toHaveValue(
    KNOWLEDGE_SOURCE_ID
  )
  await expect(history.getByText(KNOWLEDGE_SOURCE_TITLE, { exact: true }).first()).toBeVisible({
    timeout: 30_000
  })
  await expect(history.getByText('来源会话 2', { exact: true })).toHaveCount(0)
  await testInfo.attach('knowledge-source-history', {
    body: await orcaPage.screenshot(),
    contentType: 'image/png'
  })
  await history.getByRole('textbox', { name: '搜索会话', exact: true }).fill('来源会话 2')
  await expect(history.getByText('来源会话 2', { exact: true }).first()).toBeVisible()
  await orcaPage.getByRole('button', { name: '对话知识', exact: true }).click()
  await map.getByRole('button', { name: KNOWLEDGE_CONCEPT, exact: true }).click()
  await article.getByRole('button').filter({ hasText: KNOWLEDGE_SOURCE_ID }).click()
  await expect(history.getByRole('textbox', { name: '搜索会话', exact: true })).toHaveValue(
    KNOWLEDGE_SOURCE_ID
  )
  await expect(history.getByText(KNOWLEDGE_SOURCE_TITLE, { exact: true }).first()).toBeVisible()
  await expect(history.getByText('来源会话 2', { exact: true })).toHaveCount(0)
})
