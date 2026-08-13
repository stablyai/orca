// @vitest-environment happy-dom

// Regression test for #10590 (grown from the repro of the same name): the RC / perf update
// channels were only announced through a native `title` attribute, and that string never went
// through i18n.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getUpdateCheckHint } from '@/lib/update-check-click-options'

type UpdateState = 'idle' | 'checking' | 'downloading' | 'error'

let updateState: UpdateState = 'idle'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settingsSearchQuery: '',
      updateStatus: { state: updateState, version: '1.4.156', percent: 42, message: 'boom' },
      remoteServerUpdates: new Map(),
      remoteServerUpdatesChecking: false,
      remoteServerUpdatesRunning: false,
      refreshRemoteServerUpdates: vi.fn(),
      setRemoteServerUpdateDialogOpen: vi.fn()
    })
}))

vi.mock('./ReleaseChannelSection', () => ({
  ReleaseChannelSection: () => null
}))

vi.mock('./GeneralRemoteServerUpdates', () => ({
  GeneralRemoteServerUpdates: () => null
}))

import { GeneralUpdateSettingsSection } from './GeneralUpdateSettingsSection'

let root: Root | null = null
let container: HTMLDivElement | null = null

beforeEach(() => {
  updateState = 'idle'
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  window.api = {
    updater: {
      getVersion: () => Promise.resolve('1.4.155'),
      check: vi.fn(),
      download: vi.fn(),
      quitAndInstall: vi.fn()
    }
    // Minimal preload surface: only what this component reaches for.
  } as unknown as typeof window.api
})

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  root = null
  container = null
})

function renderSection(): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(<GeneralUpdateSettingsSection />)
  })
  return container
}

function findCheckForUpdatesButton(host: HTMLElement): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes('Check for Updates')
  )
  if (!button) {
    throw new Error('Check for Updates button not rendered')
  }
  return button as HTMLButtonElement
}

const LOCALE_DIR = resolve(__dirname, '../../i18n/locales')
const LOCALES = ['en', 'zh', 'ja', 'ko', 'es']

describe('#10590 update channel discoverability', () => {
  it('exposes the modifier-click channels as visible text, not only a native title', () => {
    const host = renderSection()
    const button = findCheckForUpdatesButton(host)

    // The hint exists today, but only inside `title`.
    expect(button.getAttribute('title')).toContain('checks the latest RC')

    // Correct behavior: a user who never hovers still learns the channels exist.
    const visibleText = host.textContent ?? ''
    expect(visibleText).toMatch(/latest RC/i)
    expect(visibleText).toMatch(/perf build/i)
  })

  it('keeps the channel hint reachable while a check is in flight', () => {
    updateState = 'checking'
    const host = renderSection()
    const button = findCheckForUpdatesButton(host)

    expect(button.disabled).toBe(true)
    // `disabled:pointer-events-none` on ui/button.tsx suppresses hover, so the
    // native tooltip cannot fire. The hint must live somewhere else.
    const visibleText = host.textContent ?? ''
    expect(visibleText).toMatch(/latest RC/i)
  })

  /**
   * AMENDED FROM THE ORIGINAL REPRO — called out in the PR body.
   *
   * The repro asserted the raw English sentence "checks the latest RC" appears in EVERY locale
   * file. That is unsatisfiable without violating a written repo contract:
   *   - config/i18n-translation-source.md: "Feature PRs change English only" — target catalogs
   *     never change in feature work.
   *   - verify-localization-catalog.mjs: "absent target leaves deliberately use i18next's
   *     existing English fallback"; a present value hides the key from the missing-translation
   *     report, so it would never be picked up for translation.
   *   - locale-english-regression.test.ts exists because of exactly this failure mode (#10770):
   *     "A present catalog value always beats the English translate() fallback."
   * Seeding English into zh/ja/ko/es would therefore permanently freeze this hint in English —
   * the secondary complaint in #10590 itself.
   *
   * Replaced with a strictly stronger check: the key must exist in en.json (a raw substring
   * grep proves neither the key nor the wiring), it must carry both platform placeholders, and
   * any locale that DOES translate it must keep the same placeholder set.
   */
  it('ships the update-channel hint as a translatable catalog entry', () => {
    const hint = getUpdateCheckHint(true)
    const problems: string[] = []

    const read = (locale: string): Record<string, string> =>
      JSON.parse(readFileSync(resolve(LOCALE_DIR, `${locale}.json`), 'utf8')).auto?.lib
        ?.updateCheckClickOptions ?? {}

    const english = read('en')
    for (const entry of ['hint', 'localBuildHint', 'serverHint', 'menuHint']) {
      if (typeof english[entry] !== 'string') {
        problems.push(`en.json is missing auto.lib.updateCheckClickOptions.${entry}`)
      }
    }
    if (!english.hint?.includes('checks the latest RC')) {
      problems.push('en.json hint no longer declares the RC channel')
    }

    for (const locale of LOCALES) {
      const localized = read(locale)
      for (const [entry, source] of Object.entries(english)) {
        const translated = localized[entry]
        if (translated === undefined) {
          continue // Absent on purpose: i18next falls back to the English source.
        }
        const placeholders = (value: string): string[] =>
          [...value.matchAll(/{{(\w+)}}/g)].map((match) => match[1]).sort()
        if (placeholders(translated).join() !== placeholders(source).join()) {
          problems.push(`${locale}.json ${entry} placeholders drifted from en.json`)
        }
      }
    }

    expect({ hint, problems }).toEqual({ hint, problems: [] })
  })

  it('keeps the hint visible while downloading and after an error', () => {
    for (const state of ['downloading', 'error'] as const) {
      updateState = state
      const host = renderSection()
      expect(host.textContent ?? '').toMatch(/latest RC/i)
      act(() => root?.unmount())
      container?.remove()
      root = null
      container = null
    }
  })

  it('describes the check button with the visible hint rather than the title alone', () => {
    const host = renderSection()
    const button = findCheckForUpdatesButton(host)
    const describedBy = button.getAttribute('aria-describedby')

    expect(describedBy).toBeTruthy()
    expect(host.querySelector(`#${describedBy}`)?.textContent).toContain('latest RC')
  })

  it('omits the hint in the web client, whose updater bridge is a no-op', () => {
    ;(window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    try {
      const host = renderSection()
      expect(host.textContent ?? '').not.toMatch(/latest RC/i)
      expect(findCheckForUpdatesButton(host).getAttribute('title')).toBeNull()
    } finally {
      delete (window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
    }
  })
})
