/**
 * Regression test for Hangul IME composition in the repository Display Name
 * setting (jamo decomposition: typing 가나다 produced ㄱㅏㄴㅏㄷㅏ).
 *
 * Why CDP: Playwright's keyboard API cannot drive IME composition. The CDP
 * `Input.imeSetComposition` command goes through Blink's real composition
 * pipeline, so a controlled-input value reset mid-composition cancels the
 * composition exactly like a real OS IME session.
 */
import type { CDPSession, Locator, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { getStoreState, waitForSessionReady } from './helpers/store'
import type { Repo } from '../../src/shared/types'

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

/**
 * Minimal 2-set Korean IME combination table for the key sequence ㄱㅏㄴㅏㄷㅏ.
 * Returns the next composition text, plus the syllable to commit when the new
 * key cannot join the pending composition (간 + ㅏ → commit 가, compose 나).
 */
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

/**
 * Emulates a real 2-set Korean IME typing 가나다 slowly (keys: ㄱㅏㄴㅏㄷㅏ).
 *
 * Adaptive on purpose: a real OS IME is cancelled (ImeCancelComposition) when
 * the page rewrites the text backing its composition — exactly what a
 * controlled React input does when its store echo is async. That browser→IME
 * channel is not observable from page JS (no compositionend fires), so the
 * emulator detects the same condition directly: an input event whose value the
 * page clobbered right afterwards. After a clobber the IME restarts from an
 * empty state on the next key, which is what turned 가나다 into ㄱㅏㄴㅏㄷㅏ.
 *
 * The per-key delay models slow human typing: it gives the async updateRepo
 * store echo time to land between keystrokes, which is exactly the condition
 * that produced the full jamo decomposition.
 */
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
      // Why: React restores the controlled value after the input event's
      // dispatch but later than its microtasks, so poll on a macrotask.
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

  // Why: a real IME commits the pending syllable (space/enter) at the end of a
  // word, firing compositionend. Without this final commit the controlled
  // input stays in composing state, so the component's defer-until-compositionend
  // persist never runs. insertText replaces the composing region in place, so it
  // finalizes to the same text rather than double-committing.
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

    // Why: with the store-bound controlled input, the async updateRepo echo
    // reset the field mid-composition, aborting the IME session per keystroke
    // and committing bare jamo (ㄱㅏㄴㅏㄷㅏ) instead of syllables.
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
