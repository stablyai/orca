import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test.use({ seedTestRepo: false })
test('question X closes without approval and history reopens the original question', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.setViewportSize({ width: 1200, height: 850 })
  const created = await orcaPage.evaluate(() =>
    window.api.runtime.call({
      method: 'workInbox.ask',
      params: {
        from: 'isolated-e2e-agent',
        question: 'May I deploy the isolated test?',
        options: 'Approve (recommended),Reject',
        requestId: 'close-reopen-ui',
        timeoutMs: 0
      }
    })
  )
  expect(created.ok).toBe(true)
  if (
    !created.ok ||
    typeof created.result !== 'object' ||
    !created.result ||
    !('id' in created.result) ||
    typeof created.result.id !== 'string'
  ) {
    throw new Error('Question creation failed')
  }
  const id = created.result.id
  await orcaPage.getByRole('button', { name: 'Work Inbox', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'Refresh', exact: true }).click()
  const card = orcaPage.locator('article').filter({ hasText: 'May I deploy the isolated test?' })
  await expect(card).toBeVisible()
  await card.getByRole('checkbox', { name: 'Approve (recommended)', exact: true }).click()
  await expect(card.getByRole('button', { name: 'Send answer', exact: true })).toBeEnabled()
  await orcaPage.screenshot({ path: testInfo.outputPath('question-close.png') })
  await orcaPage.evaluate(() => window.__store!.getState().updateSettingsOrThrow({ theme: 'dark' }))
  await expect(orcaPage.locator('html')).toHaveClass(/dark/)
  await expect(card).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('question-dark.png') })
  await orcaPage.evaluate(() =>
    window.__store!.getState().updateSettingsOrThrow({ theme: 'light' })
  )
  await expect(orcaPage.locator('html')).not.toHaveClass(/dark/)
  await card.getByRole('button', { name: 'Close without answering', exact: true }).click()
  await expect(card).toHaveCount(0)
  const notification = await orcaPage.evaluate(
    (id) =>
      window.api.runtime.call({
        method: 'workInbox.ask',
        params: {
          from: 'isolated-e2e-agent',
          resume: id,
          timeoutMs: 0
        }
      }),
    id
  )
  expect(notification).toMatchObject({
    ok: true,
    result: { id, cancelled: true, answer: null, message: expect.stringContaining('not approval') }
  })
  await orcaPage.getByRole('tab', { name: 'History', exact: true }).click()
  await expect(card).toBeVisible()
  await expect(card.getByText('Closed without an answer', { exact: true })).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('question-history.png') })
  await card.getByRole('button', { name: 'Reopen question' }).click()
  await expect(card).toHaveCount(0)
  await orcaPage.getByRole('tab', { name: /^Unanswered/ }).click()
  await expect(card).toBeVisible()
  const state = await orcaPage.evaluate(
    (id) => window.api.runtime.call({ method: 'workInbox.list', params: { id } }),
    id
  )
  expect(state).toMatchObject({
    ok: true,
    result: { items: [{ id, status: 'open', revision: 2 }] }
  })
  await card.getByRole('checkbox', { name: 'Reject', exact: true }).click()
  await card.getByRole('textbox').fill('Wait for review')
  await card.getByRole('button', { name: 'Send answer', exact: true }).click()
  await orcaPage.getByRole('tab', { name: 'History', exact: true }).click()
  await expect(card.getByText('Wait for review', { exact: true })).toBeVisible()
  const received = await orcaPage.evaluate(
    (id) =>
      window.api.runtime.call({
        method: 'workInbox.ask',
        params: {
          from: 'isolated-e2e-agent',
          resume: id,
          timeoutMs: 0
        }
      }),
    id
  )
  expect(received).toMatchObject({
    ok: true,
    result: { answer: { text: 'Wait for review' }, cancelled: false }
  })
  const ack = await orcaPage.evaluate(
    (id) =>
      window.api.runtime.call({
        method: 'workInbox.ack',
        params: { from: 'isolated-e2e-agent', id }
      }),
    id
  )
  expect(ack).toMatchObject({ ok: true, result: { status: 'ok', item: { status: 'delivered' } } })
  await orcaPage.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(card.getByText('Agent received', { exact: true })).toBeVisible()
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
})
