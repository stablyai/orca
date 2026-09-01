import type { Page } from '@stablyai/playwright-test'
import type { CustomTuiAgentId } from '../../src/shared/types'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { buildCustomAgent } from './helpers/custom-agent-e2e'

// The Settings → Agents pane is the authoring surface for custom agents. Unlike
// the launch surfaces (driven at the store boundary), the authoring UI IS the
// thing under test, so these specs drive it with real clicks and assert the
// change lands in the real host catalog via window.api.settings.agentCatalog.

async function openAgentsSettings(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store!.getState()
    state.openSettingsTarget({ pane: 'agents', repoId: null })
    state.openSettingsPage()
  })
  await expect(page.getByPlaceholder('Search settings')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('[data-settings-section="agents"]')).toBeVisible({ timeout: 10_000 })
  // The catalog subsection header proves the Agents pane rendered its content.
  await expect(page.getByRole('button', { name: 'New agent' })).toBeVisible({ timeout: 10_000 })
}

/** Read the ready-custom catalog entries (id + label) from the real host catalog. */
async function readReadyCustomAgents(page: Page): Promise<{ id: string; label: string }[]> {
  return await page.evaluate(async () => {
    const snapshot = await window.api.settings.agentCatalog.getLocal()
    return snapshot.customAgents
      .filter((candidate) => candidate.status === 'ready')
      .map((candidate) => ({ id: candidate.definition.id, label: candidate.definition.label }))
  })
}

test.describe('Custom agent authoring — create', () => {
  test('creates a custom agent from the New agent dialog and persists it as ready', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await openAgentsSettings(orcaPage)

    await orcaPage.getByRole('button', { name: 'New agent' }).click()
    const dialog = orcaPage.getByRole('dialog')
    await expect(dialog.getByText('New custom agent')).toBeVisible({ timeout: 10_000 })

    const AGENT_LABEL = 'Authored Agent'
    await dialog.locator('#custom-agent-name').fill(AGENT_LABEL)
    // A concrete executable path makes the saved agent a valid `configured-executable`
    // (existence is checked at launch, not authoring), so it persists as `ready`.
    await dialog.locator('#custom-agent-executable').fill('/usr/local/bin/authored-agent')
    await dialog.getByRole('button', { name: 'Save' }).click()

    // The dialog closes on a successful save and the row appears in the catalog.
    await expect(dialog).toBeHidden({ timeout: 10_000 })
    await expect(orcaPage.getByRole('button', { name: `Actions for ${AGENT_LABEL}` })).toBeVisible({
      timeout: 10_000
    })

    // The authored agent landed in the real host catalog as a ready entry.
    await expect
      .poll(async () => (await readReadyCustomAgents(orcaPage)).map((entry) => entry.label), {
        timeout: 10_000
      })
      .toContain(AGENT_LABEL)
  })

  test('blocks saving an agent with an empty name and shows a validation error', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await openAgentsSettings(orcaPage)

    await orcaPage.getByRole('button', { name: 'New agent' }).click()
    const dialog = orcaPage.getByRole('dialog')
    await expect(dialog.getByText('New custom agent')).toBeVisible({ timeout: 10_000 })

    // Save with an empty name: the editor rejects it, keeps the dialog open, and
    // renders the inline field error — nothing is persisted.
    await dialog.locator('#custom-agent-executable').fill('/usr/local/bin/nameless')
    await dialog.getByRole('button', { name: 'Save' }).click()

    await expect(dialog).toBeVisible()
    await expect(orcaPage.locator('#custom-agent-name-error')).toBeVisible({ timeout: 10_000 })
    expect(await readReadyCustomAgents(orcaPage)).toHaveLength(0)
  })
})

test.describe('Custom agent authoring — manage a seeded agent', () => {
  const SEEDED = buildCustomAgent({
    uuid: '6f7a8b9c-0d1e-4f2a-8b3c-4d5e6f708192',
    label: 'Seeded Manage Agent'
  })
  const SEEDED_ID = SEEDED.id as CustomTuiAgentId

  test.use({ seededCustomAgents: { agents: [SEEDED] } })

  test('edits a custom agent’s name and persists the change', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await openAgentsSettings(orcaPage)

    await orcaPage.getByRole('button', { name: `Actions for ${SEEDED.label}` }).click()
    await orcaPage.getByRole('menuitem', { name: 'Edit' }).click()
    const dialog = orcaPage.getByRole('dialog')
    await expect(dialog.getByText('Edit custom agent')).toBeVisible({ timeout: 10_000 })

    const NEW_LABEL = 'Renamed Manage Agent'
    await dialog.locator('#custom-agent-name').fill(NEW_LABEL)
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden({ timeout: 10_000 })

    // The same id now carries the new label in the real host catalog.
    await expect
      .poll(
        async () =>
          (await readReadyCustomAgents(orcaPage)).find((entry) => entry.id === SEEDED_ID)?.label,
        { timeout: 10_000 }
      )
      .toBe(NEW_LABEL)
  })

  test('duplicates a custom agent into a distinct new entry', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await openAgentsSettings(orcaPage)

    await orcaPage.getByRole('button', { name: `Actions for ${SEEDED.label}` }).click()
    await orcaPage.getByRole('menuitem', { name: 'Duplicate' }).click()
    const dialog = orcaPage.getByRole('dialog')
    await expect(dialog.getByText('Duplicate agent')).toBeVisible({ timeout: 10_000 })

    const COPY_LABEL = 'Duplicated Manage Agent'
    await dialog.locator('#custom-agent-name').fill(COPY_LABEL)
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden({ timeout: 10_000 })

    // Both the source and the copy now exist as distinct ready entries.
    await expect
      .poll(async () => (await readReadyCustomAgents(orcaPage)).map((entry) => entry.label), {
        timeout: 10_000
      })
      .toEqual(expect.arrayContaining([SEEDED.label, COPY_LABEL]))
    const entries = await readReadyCustomAgents(orcaPage)
    const copy = entries.find((entry) => entry.label === COPY_LABEL)
    expect(copy?.id).not.toBe(SEEDED_ID)
  })

  test('deletes a custom agent after confirming the destructive dialog', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await openAgentsSettings(orcaPage)

    await orcaPage.getByRole('button', { name: `Actions for ${SEEDED.label}` }).click()
    await orcaPage.getByRole('menuitem', { name: 'Delete' }).click()
    const dialog = orcaPage.getByRole('dialog')
    await expect(dialog.getByText(`Delete ${SEEDED.label}?`)).toBeVisible({ timeout: 10_000 })

    await dialog.getByRole('button', { name: 'Delete agent' }).click()
    await expect(dialog).toBeHidden({ timeout: 10_000 })

    // The agent is gone from the ready catalog and its row is removed.
    await expect
      .poll(async () => (await readReadyCustomAgents(orcaPage)).map((entry) => entry.id), {
        timeout: 10_000
      })
      .not.toContain(SEEDED_ID)
    await expect(orcaPage.getByRole('button', { name: `Actions for ${SEEDED.label}` })).toHaveCount(
      0
    )
  })

  test('disables a custom agent via the row switch', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await openAgentsSettings(orcaPage)

    const enableSwitch = orcaPage.getByRole('switch', { name: `Enable ${SEEDED.label}` })
    await expect(enableSwitch).toBeChecked()
    await enableSwitch.click()

    // The disable landed in the real host settings (disabled agents are excluded
    // from the launch pickers' merge).
    await expect
      .poll(
        async () =>
          orcaPage.evaluate(async (id) => {
            const settings = await window.api.settings.get()
            return (settings.disabledTuiAgents ?? []).includes(id)
          }, SEEDED_ID),
        { timeout: 10_000 }
      )
      .toBe(true)
  })
})
