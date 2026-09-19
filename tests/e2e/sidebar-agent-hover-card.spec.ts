import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { worktreeRow } from './worktree-row-locators'

/**
 * The sidebar row used to explain itself through the native `title` tooltip: raw
 * markdown in an OS blob. It now opens a hover card that names the workspace and
 * renders the reply. Radix only opens on real pointer movement, so the unit tests
 * mock it away — this is the only place the real card is exercised.
 */

const ASSISTANT_MESSAGE = [
  '**Dry-run do acordo**',
  '',
  'Ja funciona: a sessao guarda parcelas, entrada e vencimento.'
].join('\n')

const PROMPT = 'MIA-1051 dry-run acordo no after-service'

/** Pathological content: no spaces to wrap at, plus a reply far taller than the card. */
const GIANT_PROMPT = `rodar-o-dry-run-completo-${'x'.repeat(300)}`
const GIANT_MODEL = `claude-opus-5-1-20260514-${'y'.repeat(120)}`
const GIANT_NAME = `workspace-${'q'.repeat(300)}`
const GIANT_MESSAGE = [
  '**Resumo**',
  '',
  `https://exemplo.invalido/${'z'.repeat(300)}`,
  '',
  ...Array.from({ length: 40 }, (_, index) => `- Caso ${index + 1}: tudo certo com esse caso`)
].join('\n')

function hoverCard(page: Page) {
  // The card is portaled to the body, so it never descends from the row.
  return page.locator('[data-slot="hover-card-content"]').filter({ hasText: PROMPT })
}

test.describe('Sidebar agent row hover card', () => {
  test('opens a card with the workspace and the rendered reply', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    const worktreeId = await waitForActiveWorktree(orcaPage)

    await orcaPage.evaluate(
      ({ worktreeId, prompt, message }) => {
        const store = window.__store
        if (!store) {
          throw new Error('window.__store is not available')
        }
        const state = store.getState()
        if (!state.worktreeCardProperties.includes('inline-agents')) {
          state.toggleWorktreeCardProperty('inline-agents')
        }
        if ((state.tabsByWorktree[worktreeId] ?? []).length === 0) {
          state.createTab(worktreeId)
        }
        const tab = (store.getState().tabsByWorktree[worktreeId] ?? [])[0]!
        const now = Date.now()
        store.getState().setAgentStatus(
          `${tab.id}:${crypto.randomUUID()}`,
          {
            state: 'done',
            prompt,
            agentType: 'claude',
            model: 'Fable 5.1',
            lastAssistantMessage: message
          },
          'claude',
          { updatedAt: now, stateStartedAt: now }
        )
      },
      { worktreeId, prompt: PROMPT, message: ASSISTANT_MESSAGE }
    )

    const workspaceName = await orcaPage.evaluate((id) => {
      const store = window.__store
      const worktree = Object.values(store?.getState().worktreesByRepo ?? {})
        .flat()
        .find((candidate) => candidate.id === id)
      return worktree?.displayName ?? ''
    }, worktreeId)
    expect(workspaceName).not.toBe('')

    const row = worktreeRow(orcaPage, worktreeId).locator('.compact-agent-row').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    // The message must not ride along in a native tooltip any more.
    await expect(row).not.toHaveAttribute('title', /Dry-run/)

    await row.hover()

    const card = hoverCard(orcaPage)
    await expect(card).toBeVisible({ timeout: 10_000 })
    // The card carries the workspace the row belongs to, not just the session.
    await expect(card).toContainText(workspaceName)
    await expect(card).toContainText('Fable 5.1')
    // Rendered markdown, not the raw asterisks the row used to show.
    await expect(card.locator('strong', { hasText: 'Dry-run do acordo' })).toBeVisible({
      timeout: 10_000
    })
    await expect(card).not.toContainText('**Dry-run do acordo**')

    // Moving away closes it, so the card never sits over the sidebar.
    await orcaPage.mouse.move(900, 500)
    await expect(card).toBeHidden({ timeout: 10_000 })
  })

  test('keeps its box when the workspace name and the reply are pathological', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    const worktreeId = await waitForActiveWorktree(orcaPage)

    await orcaPage.evaluate(
      ({ worktreeId, name, prompt, model, message }) => {
        const store = window.__store
        if (!store) {
          throw new Error('window.__store is not available')
        }
        const state = store.getState()
        if (!state.worktreeCardProperties.includes('inline-agents')) {
          state.toggleWorktreeCardProperty('inline-agents')
        }
        if ((state.tabsByWorktree[worktreeId] ?? []).length === 0) {
          state.createTab(worktreeId)
        }
        // A name with nothing to wrap at is the worst case for the card's box.
        store.setState((current) => ({
          worktreesByRepo: Object.fromEntries(
            Object.entries(current.worktreesByRepo).map(([repoId, repoWorktrees]) => [
              repoId,
              repoWorktrees.map((worktree) =>
                worktree.id === worktreeId ? { ...worktree, displayName: name } : worktree
              )
            ])
          )
        }))
        const tab = (store.getState().tabsByWorktree[worktreeId] ?? [])[0]!
        const now = Date.now()
        store.getState().setAgentStatus(
          `${tab.id}:${crypto.randomUUID()}`,
          {
            state: 'done',
            prompt,
            agentType: 'claude',
            model,
            lastAssistantMessage: message,
            subagents: Array.from({ length: 12 }, (_, index) => ({
              id: `sub-${index}`,
              agentType: 'claude',
              description: `subagente-de-nome-enorme-${'w'.repeat(120)}-${index}`,
              state: 'working' as const,
              startedAt: now
            }))
          },
          'claude',
          { updatedAt: now, stateStartedAt: now }
        )
      },
      {
        worktreeId,
        name: GIANT_NAME,
        prompt: GIANT_PROMPT,
        model: GIANT_MODEL,
        message: GIANT_MESSAGE
      }
    )

    const row = worktreeRow(orcaPage, worktreeId).locator('.compact-agent-row').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.hover()

    const card = orcaPage.locator('[data-slot="hover-card-content"]').last()
    await expect(card).toBeVisible({ timeout: 10_000 })
    await expect(card.locator('[data-worktree-hover-subagent]')).toHaveCount(5)
    await expect(card.locator('[data-worktree-hover-title]')).toBeVisible()

    const box = await card.evaluate((element) => {
      const scroller = element.querySelector('.scrollbar-sleek')
      // A code block scrolls sideways on purpose; nothing else may.
      const sidewaysScrollers: string[] = []
      const walk = (node: Element): void => {
        if (node.tagName !== 'PRE' && node.scrollWidth - node.clientWidth > 1) {
          const clipped = getComputedStyle(node).textOverflow === 'ellipsis'
          if (!clipped) {
            sidewaysScrollers.push(node.className.toString().slice(0, 80))
          }
        }
        for (const child of node.children) {
          walk(child)
        }
      }
      walk(element)
      return {
        width: Math.round(element.getBoundingClientRect().width),
        height: Math.round(element.getBoundingClientRect().height),
        scrollerHeight: scroller ? scroller.clientHeight : 0,
        scrollerScrollHeight: scroller ? scroller.scrollHeight : 0,
        sidewaysScrollers
      }
    })

    // The card owns its box; long content scrolls vertically inside it.
    expect(box.sidewaysScrollers).toEqual([])
    expect(box.width).toBeLessThanOrEqual(340)
    expect(box.height).toBeLessThanOrEqual(430)
    expect(box.scrollerHeight).toBeLessThanOrEqual(400)
    expect(box.scrollerScrollHeight).toBeGreaterThan(box.scrollerHeight)
  })
})
