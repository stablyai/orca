// Reproduce 가나다 → ㄱㅏㄴㅏㄷㅏ from controlled Display Name resets during real Blink composition.
// Use CDP Input.imeSetComposition because Playwright keyboard events cannot drive IME composition.
import type { CDPSession, Locator, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { getStoreState, waitForSessionReady } from './helpers/store'
import type { Repo } from '../../src/shared/repo-types'

async function openRepoSettings(page: Page, repoId: string): Promise<void> {
  await page.evaluate((repoId) => {
    const state = window.__store!.getState()
    state.openSettingsTarget({ pane: 'repo', repoId })
    state.openSettingsPage()
  }, repoId)
  await expect(page.getByPlaceholder('Search settings')).toBeVisible({ timeout: 10_000 })
  // Why: first-run announcements can cover the settings pane on fresh profiles.
  const maybeLaterButton = page.getByRole('button', { name: 'Maybe Later' })
  if (await maybeLaterButton.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await maybeLaterButton.click()
  }
}

// Model 2-set Korean ㄱㅏㄴㅏㄷㅏ joins and commits when a key cannot extend the pending syllable.
function combineJamo(pending: string, key: string): { commit?: string; compose: string } {
  const joins: Record<string, { commit?: string; compose: string }> = {
    'ㄱ+ㅏ': { compose: '가' },
    'ㄴ+ㅏ': { compose: '나' },
    'ㄷ+ㅏ': { compose: '다' },
    '가+ㄴ': { compose: '간' },
    '간+ㅏ': { commit: '가', compose: '나' },
    '나+ㄷ': { compose: '낟' },
    '낟+ㅏ': { commit: '나', compose: '다' }
  }
  if (!pending) {
    return { compose: key }
  }
  // Why: like a real IME, a non-joinable key commits the pending text and
  // starts a fresh composition with just the new key.
  return joins[`${pending}+${key}`] ?? { commit: pending, compose: key }
}

// Emulate slow Korean IME typing and detect controlled-value clobbers after input; browser IME cancellation emits no observable compositionend.
// Restart composition after each clobber, reproducing per-key async store echoes that split syllables into bare jamo.
async function typeHangulGanadaSlowly(
  session: CDPSession,
  page: Page,
  input: Locator
): Promise<void> {
  await input.evaluate((el) => {
    const w = window as unknown as { __imeClobbered?: boolean }
    w.__imeClobbered = false
    el.addEventListener('input', () => {
      const seen = (el as HTMLInputElement).value
      // Poll on a macrotask because React restores controlled values after input microtasks.
      setTimeout(() => {
        if ((el as HTMLInputElement).value !== seen) {
          w.__imeClobbered = true
        }
      }, 0)
    })
  })
  const takeClobbered = (): Promise<boolean> =>
    page.evaluate(() => {
      const w = window as unknown as { __imeClobbered?: boolean }
      const clobbered = w.__imeClobbered === true
      w.__imeClobbered = false
      return clobbered
    })

  let committed = ''
  let pending = ''
  for (const key of ['ㄱ', 'ㅏ', 'ㄴ', 'ㅏ', 'ㄷ', 'ㅏ']) {
    if (await takeClobbered()) {
      committed = await input.inputValue()
      pending = ''
    }
    const { commit, compose } = combineJamo(pending, key)
    if (commit) {
      committed += commit
    }
    const compositionText = `${committed}${compose}`
    await session.send('Input.imeSetComposition', {
      text: compositionText,
      selectionStart: compositionText.length,
      selectionEnd: compositionText.length
    })
    pending = compose
    // Slow typing: let the async store echo land before the next key.
    await page.waitForTimeout(200)
  }

  // Finish with compositionend so deferred persistence runs; insertText replaces the current region without double-committing.
  await session.send('Input.insertText', { text: committed + pending })
}

test.describe('Repository Display Name IME composition', () => {
  test('keeps Hangul syllables composed while typing slowly', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)

    const repos = await getStoreState<Repo[]>(orcaPage, 'repos')
    expect(repos.length).toBeGreaterThan(0)
    const repo = repos[0]

    await openRepoSettings(orcaPage, repo.id)

    const repoSection = orcaPage.locator(`[data-settings-section="repo-${repo.id}"]`)
    const displayNameInput = repoSection.getByLabel('Display Name')
    await expect(displayNameInput).toHaveValue(repo.displayName)

    // Clear and wait for the async store echo to settle before composing.
    await displayNameInput.click()
    await displayNameInput.fill('')
    await expect(displayNameInput).toHaveValue('')

    const session = await orcaPage.context().newCDPSession(orcaPage)
    await typeHangulGanadaSlowly(session, orcaPage, displayNameInput)

    // Require composed syllables despite async updateRepo echoes that previously cancelled each key.
    await expect(displayNameInput).toHaveValue('가나다')

    // The per-keystroke persist still reaches the store.
    await expect
      .poll(
        async () => {
          const current = await getStoreState<Repo[]>(orcaPage, 'repos')
          return current.find((entry) => entry.id === repo.id)?.displayName
        },
        { timeout: 5_000, message: 'display name did not persist to the store' }
      )
      .toBe('가나다')
  })
})
