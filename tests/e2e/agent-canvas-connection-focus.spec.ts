import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('keeps connection details focused when opened from either canvas menu', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await orcaPage.evaluate((worktreeId) => {
    const state = window.__store!.getState()
    const canvas = state.createUnifiedTab(worktreeId, 'canvas', { label: 'Focus test' })
    const scope = JSON.stringify(['workspace-tab', canvas.executionHostId, worktreeId, canvas.id])
    localStorage.setItem(
      `orca.agent-canvas.v1:${scope}`,
      JSON.stringify({
        version: 1,
        viewport: { x: 40, y: 40, zoom: 1 },
        nodes: [
          {
            id: 'note',
            kind: 'note',
            title: 'Review checklist',
            content: 'Check login and logout.',
            position: { x: 0, y: 0 },
            width: 320,
            height: 240
          },
          {
            id: 'agent',
            kind: 'agent',
            title: 'Reviewer',
            content: '',
            position: { x: 400, y: 0 },
            width: 480,
            height: 360
          }
        ],
        edges: [{ id: 'connection', source: 'note', target: 'agent' }]
      })
    )
    state.activateTab(canvas.id)
  }, worktreeId)
  const choose = orcaPage
    .locator('[data-canvas-kind="note"]')
    .getByRole('button', { name: 'Choose agent from list', exact: true })
  await choose.click()
  await orcaPage.getByRole('dialog').getByRole('combobox').press('Escape')
  await expect(choose).toBeFocused()
  await choose.click()
  await orcaPage.getByRole('dialog').getByRole('combobox').press('ArrowDown')
  await orcaPage.getByRole('dialog').getByRole('combobox').press('Enter')
  const close = orcaPage.getByRole('button', { name: 'Close connection details', exact: true })
  await expect(close).toBeFocused()
  await expect(orcaPage.getByLabel('Linked note')).toHaveText('Check login and logout.')
  await close.click()
  await orcaPage.getByRole('button', { name: 'Attached notes', exact: true }).click()
  await orcaPage.getByRole('dialog').getByRole('button', { name: 'Review checklist' }).click()
  await expect(close).toBeFocused()
  await orcaPage.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect(orcaPage.locator('.react-flow__edge')).toHaveCount(0)
  await expect(orcaPage.getByLabel('Linked note')).toHaveCount(0)
})
