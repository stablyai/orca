import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

const SHOT_DIR =
  process.env.ORCA_TRUST_CARD_SHOT_DIR ?? path.join(process.cwd(), 'trust-card-screenshots')

type DecideArgs = {
  target: { kind: 'repo'; repoId: string }
  scope: 'workspace' | 'parent'
  decision: 'trust' | 'decline'
}

test.describe('Repository workspace trust status card', () => {
  test('renders each recorded decision and its actions', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)

    const repoId = await orcaPage.evaluate(async () => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      // Why: the spec asserts on English strings; the host may run another system locale.
      await store.getState().updateSettings({ uiLanguage: 'en' })
      store.getState().openSettingsPage()
      const repo = store.getState().repos[0]
      if (!repo) {
        throw new Error('no seeded repo in the store')
      }
      return repo.id as string
    })

    const search = orcaPage.getByPlaceholder('Search settings')
    await expect(search).toBeVisible()
    await search.fill('Workspace Trust')

    const heading = orcaPage.getByRole('heading', { name: 'Workspace Trust', exact: true }).first()
    await expect(heading).toBeVisible()
    const card = orcaPage
      .locator('section')
      .filter({ has: orcaPage.getByRole('heading', { name: 'Workspace Trust', exact: true }) })
      .first()

    const decide = async (args: DecideArgs): Promise<string | null> =>
      orcaPage.evaluate(async (a: DecideArgs) => {
        const entry = await window.api.workspaceTrust.decide(a)
        return entry?.id ?? null
      }, args)

    const revoke = async (entryId: string): Promise<void> => {
      await orcaPage.evaluate(async (id: string) => {
        await window.api.workspaceTrust.revoke({ entryId: id })
      }, entryId)
    }

    // 1. No decision recorded yet — the seeded repo starts with no entry.
    await expect(card.getByText('Not trusted', { exact: true })).toBeVisible()
    await card.screenshot({ path: path.join(SHOT_DIR, '1-undecided.png') })

    // 2. Trusted for this exact location.
    const directId = await decide({
      target: { kind: 'repo', repoId },
      scope: 'workspace',
      decision: 'trust'
    })
    expect(directId).not.toBeNull()
    await expect(card.getByText('Trusted', { exact: true })).toBeVisible()
    await card.screenshot({ path: path.join(SHOT_DIR, '2-trusted-direct.png') })
    await revoke(directId as string)

    // 3. Trusted through an ancestor — the card must name it and offer both exits.
    const parentId = await decide({
      target: { kind: 'repo', repoId },
      scope: 'parent',
      decision: 'trust'
    })
    expect(parentId).not.toBeNull()
    await expect(card.getByText(/Trust inherited from/)).toBeVisible()
    await card.screenshot({ path: path.join(SHOT_DIR, '3-trusted-inherited.png') })
    await revoke(parentId as string)

    // 4. A remembered decline is not the absence of a decision.
    const declinedId = await decide({
      target: { kind: 'repo', repoId },
      scope: 'workspace',
      decision: 'decline'
    })
    expect(declinedId).not.toBeNull()
    await expect(card.getByText('Not trusted', { exact: true })).toBeVisible()
    await card.screenshot({ path: path.join(SHOT_DIR, '4-declined.png') })
  })
})
