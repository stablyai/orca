import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { worktreeRow } from './worktree-row-locators'

for (const mode of ['full', 'compact'] as const) {
  test(`sidebar agents follow a real tab drag (${mode})`, async ({ orcaPage }, testInfo) => {
    await waitForSessionReady(orcaPage)
    const worktreeId = await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await orcaPage.evaluate(
      ({ worktreeId, mode }) => {
        const store = window.__store
        if (!store) {
          throw new Error('Missing E2E store')
        }
        const state = store.getState()
        state.setAgentActivityDisplayMode(mode)
        state.setWorktreeCardProperties([...state.worktreeCardProperties, 'inline-agents'])
        while ((store.getState().tabsByWorktree[worktreeId] ?? []).length < 2) {
          store.getState().createTab(worktreeId)
        }
      },
      { worktreeId, mode }
    )
    await orcaPage.waitForFunction((worktreeId) => {
      const state = window.__store?.getState()
      const tabs = state?.tabsByWorktree[worktreeId] ?? []
      return (
        tabs.length >= 2 &&
        tabs
          .slice(0, 2)
          .every((tab) => state?.terminalLayoutsByTabId[tab.id]?.root?.type === 'leaf')
      )
    }, worktreeId)
    const paneKeys = await orcaPage.evaluate((worktreeId) => {
      const store = window.__store
      if (!store) {
        throw new Error('Missing E2E store')
      }
      const state = store.getState()
      return (state.tabsByWorktree[worktreeId] ?? []).slice(0, 2).map((tab, index) => {
        const agentType = index === 0 ? 'claude' : 'codex'
        const leaf = state.terminalLayoutsByTabId[tab.id]?.root
        if (leaf?.type !== 'leaf') {
          throw new Error('Missing terminal leaf')
        }
        const paneKey = `${tab.id}:${leaf.leafId}`
        state.setTabCustomTitle(tab.id, index === 0 ? 'Claude order proof' : 'Codex order proof')
        state.setAgentStatus(
          paneKey,
          { state: 'working', agentType, prompt: `${agentType} task` },
          agentType,
          { updatedAt: Date.now(), stateStartedAt: Date.now() - index * 1000 }
        )
        return paneKey
      })
    }, worktreeId)

    const card = worktreeRow(orcaPage, worktreeId)
    if (mode === 'compact') {
      await card.locator('button.compact-agent-summary-button').click()
    }
    const rows = card.locator('[data-agent-reorder-key]')
    await expect(rows).toHaveCount(2)
    await expect
      .poll(() =>
        rows.evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute('data-agent-reorder-key'))
        )
      )
      .toEqual(paneKeys)
    await testInfo.attach(`${mode}-before`, {
      body: await orcaPage.screenshot(),
      contentType: 'image/png'
    })

    const first = orcaPage
      .locator('[data-testid="sortable-tab"]')
      .filter({ hasText: 'Claude order proof' })
    const second = orcaPage
      .locator('[data-testid="sortable-tab"]')
      .filter({ hasText: 'Codex order proof' })
    const from = await first.boundingBox()
    const to = await second.boundingBox()
    if (!from || !to) {
      throw new Error('Tab strip was not rendered')
    }
    await orcaPage.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(to.x + to.width * 0.8, to.y + to.height / 2, { steps: 8 })
    await orcaPage.mouse.up()

    await expect
      .poll(() =>
        rows.evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute('data-agent-reorder-key'))
        )
      )
      .toEqual(paneKeys.toReversed())
    await expect
      .poll(() =>
        orcaPage
          .locator('[data-testid="sortable-tab"]')
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-tab-title')))
      )
      .toEqual(['Codex order proof', 'Claude order proof'])
    const interruption = await rows.evaluateAll(async (nodes) => {
      const store = window.__store
      if (!store) {
        throw new Error('Missing E2E store')
      }
      const state = store.getState()
      const group = Object.values(state.groupsByWorktree)
        .flat()
        .find((candidate) =>
          candidate.tabOrder.some((id) =>
            state.unifiedTabsByWorktree[candidate.worktreeId]?.some(
              (tab) => tab.id === id && tab.customLabel === 'Claude order proof'
            )
          )
        )
      if (!group) {
        throw new Error('Missing proof tab group')
      }
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      nodes.forEach((node) => node.getAnimations().forEach((animation) => animation.finish()))
      store.getState().reorderUnifiedTabs(group.id, group.tabOrder.toReversed())
      for (let i = 0; i < 10 && !nodes.some((node) => node.getAnimations().length); i++) {
        await frame()
      }
      const initial = nodes.flatMap((node) => node.getAnimations())
      if (initial.length !== nodes.length) {
        throw new Error('Expected a running reorder animation on each row')
      }
      initial.forEach((animation) => {
        animation.pause()
        animation.currentTime = 20
        // Keep playState running while preserving a deterministic early sample.
        animation.playbackRate = 0
        animation.play()
      })
      const before = nodes.map((node) => node.getBoundingClientRect().top)
      const residuals = nodes.map((node) =>
        Number.parseFloat(getComputedStyle(node).translate.split(' ')[1] ?? '0')
      )
      store.getState().reorderUnifiedTabs(group.id, group.tabOrder)
      for (let i = 0; i < 10 && initial.some((animation) => animation.playState !== 'idle'); i++) {
        await frame()
      }
      const next = nodes.flatMap((node) => node.getAnimations())
      if (
        next.length !== nodes.length ||
        initial.some((animation) => animation.playState !== 'idle')
      ) {
        throw new Error('Expected replacement animations after interrupting the reorder')
      }
      next.forEach((animation) => {
        animation.pause()
        animation.currentTime = 0
      })
      const after = nodes.map((node) => node.getBoundingClientRect().top)
      next.forEach((animation) => animation.finish())
      return { before, after, residuals }
    })
    expect(Math.max(...interruption.residuals.map(Math.abs))).toBeGreaterThan(5)
    interruption.before.forEach((top, index) => {
      expect(Math.abs(top - interruption.after[index])).toBeLessThan(0.5)
    })
    await expect(first).toHaveAttribute('data-active', 'false')
    await rows.filter({ hasText: 'Claude order proof' }).click()
    await expect(first).toHaveAttribute('data-active', 'true')
    await testInfo.attach(`${mode}-after`, {
      body: await orcaPage.screenshot(),
      contentType: 'image/png'
    })
  })
}
