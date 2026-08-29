/**
 * STA-3067: SSH host add/edit form must open as a modal dialog so fields stay
 * in the viewport when the host list is long (instead of mounting inline below
 * the list).
 */

import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

// Why: afterEach deletes every target carrying this prefix, so two workers loading
// the module in the same millisecond must not collide on a shared Date.now().
const HOST_PREFIX = `e2e-ssh-modal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

async function dismissTransientAnnouncement(page: Page): Promise<void> {
  const maybeLaterButton = page.getByRole('button', { name: 'Maybe Later' })
  // Why: isVisible() is one-shot (its timeout is ignored); the retrying assertion
  // gives a late-rendering announcement a chance to appear before we move on.
  const visible = await expect(maybeLaterButton)
    .toBeVisible({ timeout: 1_000 })
    .then(() => true)
    .catch(() => false)
  if (visible) {
    await maybeLaterButton.click()
  }
}

async function seedSshTargets(
  page: Page,
  count: number
): Promise<{ ids: string[]; labels: string[] }> {
  return page.evaluate(
    async ({ count, prefix }) => {
      const ids: string[] = []
      const labels: string[] = []
      for (let index = 0; index < count; index += 1) {
        const label = `${prefix}-seed-${index}`
        const result = await window.api.ssh.addTarget({
          target: {
            label,
            host: `seed-${index}.${prefix}.example.test`,
            port: 22,
            username: 'deploy',
            // Why: keep relay cleanup short if a later suite connects these stubs.
            relayGracePeriodSeconds: 60
          }
        })
        ids.push(result.target.id)
        labels.push(label)
        window.__store?.getState().recordSshRepoReadoptions(result.repoReadoptions)
      }
      return { ids, labels }
    },
    { count, prefix: HOST_PREFIX }
  )
}

async function removeSshTargets(page: Page, ids: string[]): Promise<void> {
  await page.evaluate(async (targetIds) => {
    for (const id of targetIds) {
      try {
        await window.api.ssh.removeTarget({ id })
      } catch {
        // Best-effort cleanup — target may already be gone.
      }
    }
  }, ids)
}

async function openSshHostSettings(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('store unavailable')
    }
    state.openSettingsTarget({ pane: 'ssh', repoId: null })
    state.openSettingsPage()
  })
  await expect(page.getByPlaceholder('Search settings')).toBeVisible({ timeout: 10_000 })
  await dismissTransientAnnouncement(page)
  const sshSection = page.locator('[data-settings-section="ssh"]')
  await expect(sshSection).toBeVisible({ timeout: 10_000 })
  // Why: section chrome uses "SSH Hosts"; the pane body catalog string is "Targets".
  await expect(sshSection.getByRole('heading', { name: 'SSH Hosts' })).toBeVisible()
  await expect(sshSection.getByRole('button', { name: 'Add Target' })).toBeVisible({
    timeout: 10_000
  })
}

async function listTargetIdsByLabelPrefix(page: Page, prefix: string): Promise<string[]> {
  return page.evaluate(async (labelPrefix) => {
    const targets = (await window.api.ssh.listTargets()) as { id: string; label: string }[]
    return targets
      .filter((target) => target.label.startsWith(labelPrefix))
      .map((target) => target.id)
  }, prefix)
}

test.describe('SSH host add/edit modal', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
  })

  test.afterEach(async ({ orcaPage }) => {
    const ids = await listTargetIdsByLabelPrefix(orcaPage, HOST_PREFIX)
    if (ids.length > 0) {
      await removeSshTargets(orcaPage, ids)
    }
  })

  test('opens add/edit form in a viewport-stable dialog over a long host list', async ({
    orcaPage
  }) => {
    const seeded = await seedSshTargets(orcaPage, 10)
    await openSshHostSettings(orcaPage)

    const sshSection = orcaPage.locator('[data-settings-section="ssh"]')
    // Why: seed first, then open settings so SshPane's listTargets load includes them.
    for (const label of seeded.labels.slice(0, 3)) {
      await expect(sshSection.getByText(label, { exact: true })).toBeVisible()
    }

    // ── Add flow ────────────────────────────────────────────────────
    await sshSection.getByRole('button', { name: 'Add Target' }).click()

    const addDialog = orcaPage.getByRole('dialog', { name: 'Add SSH host' })
    await expect(addDialog).toBeVisible()
    await expect(addDialog.getByRole('heading', { name: 'Add SSH host' })).toBeInViewport()
    await expect(
      addDialog.getByText('Add a persistent machine you can log into over SSH.')
    ).toBeInViewport()
    await expect(addDialog.getByRole('button', { name: 'Add Target' })).toBeInViewport()
    await expect(addDialog.getByRole('button', { name: 'Cancel' })).toBeInViewport()

    // Why: Advanced expands the form; sticky header/footer must stay on screen.
    await addDialog.getByRole('button', { name: 'Advanced' }).click()
    await expect(addDialog.getByText('Proxy Command')).toBeVisible()
    await expect(addDialog.getByRole('heading', { name: 'Add SSH host' })).toBeInViewport()
    await expect(addDialog.getByRole('button', { name: 'Add Target' })).toBeInViewport()

    // Collapse before save so the dialog body is quieter; Advanced state is
    // re-checked on the next open session.
    await addDialog.getByRole('button', { name: 'Advanced' }).click()

    const createdLabel = `${HOST_PREFIX}-created`
    await addDialog.locator('#ssh-target-label').fill(createdLabel)
    await addDialog.locator('#ssh-target-host').fill('created.example.test')
    await addDialog.locator('#ssh-target-username').fill('alice')
    await addDialog.locator('#ssh-target-port').fill('2222')
    await addDialog.getByRole('button', { name: 'Add Target' }).click()

    await expect(addDialog).toBeHidden({ timeout: 10_000 })
    await expect(sshSection.getByText(createdLabel, { exact: true })).toBeVisible({
      timeout: 10_000
    })
    await expect(sshSection.getByText('alice@created.example.test:2222')).toBeVisible()

    // ── Edit flow stays in viewport even with a long list above ─────
    const createdCard = sshSection.locator(
      `[data-ssh-target-card][data-ssh-target-label="${createdLabel}"]`
    )
    await createdCard.getByRole('button', { name: 'Edit target' }).click()

    const editDialog = orcaPage.getByRole('dialog', { name: 'Edit SSH host' })
    await expect(editDialog).toBeVisible()
    await expect(editDialog.getByRole('heading', { name: 'Edit SSH host' })).toBeInViewport()
    await expect(
      editDialog.getByText(
        'Update connection details for this machine. Changes apply on next connect.'
      )
    ).toBeInViewport()
    await expect(editDialog.getByText('Editing')).toBeVisible()
    await expect(editDialog.getByText(createdLabel, { exact: true })).toBeVisible()
    await expect(editDialog.getByText('alice@created.example.test:2222')).toBeVisible()
    await expect(editDialog.getByRole('button', { name: 'Save Changes' })).toBeInViewport()

    // Advanced starts collapsed for a target without advanced fields.
    await expect(editDialog.getByRole('button', { name: 'Advanced' })).toHaveAttribute(
      'data-state',
      'closed'
    )
    await editDialog.getByRole('button', { name: 'Advanced' }).click()
    await expect(editDialog.getByRole('button', { name: 'Advanced' })).toHaveAttribute(
      'data-state',
      'open'
    )
    await expect(editDialog.getByRole('heading', { name: 'Edit SSH host' })).toBeInViewport()
    await expect(editDialog.getByRole('button', { name: 'Save Changes' })).toBeInViewport()

    // Dirty outside-click must not discard the draft.
    await editDialog.locator('#ssh-target-label').fill(`${createdLabel}-dirty`)
    await orcaPage.locator('[data-slot="dialog-overlay"]').click({ position: { x: 8, y: 8 } })
    await expect(editDialog).toBeVisible()
    await expect(editDialog.locator('#ssh-target-label')).toHaveValue(`${createdLabel}-dirty`)

    // Explicit cancel discards; reopening must reset Advanced.
    await editDialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(editDialog).toBeHidden()

    await createdCard.getByRole('button', { name: 'Edit target' }).click()
    const reopened = orcaPage.getByRole('dialog', { name: 'Edit SSH host' })
    await expect(reopened).toBeVisible()
    await expect(reopened.locator('#ssh-target-label')).toHaveValue(createdLabel)
    await expect(reopened.getByRole('button', { name: 'Advanced' })).toHaveAttribute(
      'data-state',
      'closed'
    )
    await reopened.getByRole('button', { name: 'Cancel' }).click()
  })

  test('add-ssh-host settings intent opens the same modal dialog', async ({ orcaPage }) => {
    await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('store unavailable')
      }
      state.openSettingsTarget({ pane: 'ssh', repoId: null, intent: 'add-ssh-host' })
      state.openSettingsPage()
    })
    await expect(orcaPage.getByPlaceholder('Search settings')).toBeVisible({ timeout: 10_000 })
    await dismissTransientAnnouncement(orcaPage)

    const dialog = orcaPage.getByRole('dialog', { name: 'Add SSH host' })
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await expect(dialog.getByRole('heading', { name: 'Add SSH host' })).toBeInViewport()
    await expect(dialog.locator('#ssh-target-host')).toBeFocused()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
  })
})
