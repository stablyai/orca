import { afterAll, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import {
  getRemoteServerUpdateCheckClickOptions,
  getRemoteServerUpdateCheckHint,
  getUpdateCheckClickOptions,
  getUpdateCheckHint,
  getUpdateCheckMenuHint
} from './update-check-click-options'

function clickEvent(
  overrides: Partial<Pick<MouseEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>>
) {
  return {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides
  } as Pick<MouseEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>
}

describe('getUpdateCheckClickOptions', () => {
  it('uses Cmd on macOS for perf prerelease checks', () => {
    expect(getUpdateCheckClickOptions(clickEvent({ metaKey: true }), true)).toEqual({
      includePrerelease: false,
      includePerfPrerelease: true
    })
    expect(getUpdateCheckClickOptions(clickEvent({ ctrlKey: true }), true)).toEqual({
      includePrerelease: false,
      includePerfPrerelease: false
    })
  })

  it('uses Ctrl outside macOS for perf prerelease checks', () => {
    expect(getUpdateCheckClickOptions(clickEvent({ ctrlKey: true }), false)).toEqual({
      includePrerelease: false,
      includePerfPrerelease: true
    })
    expect(getUpdateCheckClickOptions(clickEvent({ metaKey: true }), false)).toEqual({
      includePrerelease: false,
      includePerfPrerelease: false
    })
  })

  it('keeps Shift as the RC prerelease modifier', () => {
    expect(
      getUpdateCheckClickOptions(clickEvent({ shiftKey: true, ctrlKey: true }), false)
    ).toEqual({
      includePrerelease: true,
      includePerfPrerelease: true
    })
  })

  it('gives local build selection precedence over release channel modifiers', () => {
    expect(
      getUpdateCheckClickOptions(clickEvent({ altKey: true, shiftKey: true, metaKey: true }), true)
    ).toEqual({ localBuild: true })
    expect(getUpdateCheckClickOptions(clickEvent({ altKey: true }), false)).toEqual({
      includePrerelease: false,
      includePerfPrerelease: false
    })
  })

  it('formats the tooltip hint by platform', () => {
    expect(getUpdateCheckHint(true)).toBe(
      '⇧+click checks the latest RC; ⌘+click checks the latest perf build. ⌥+click chooses a local macOS build.'
    )
    expect(getUpdateCheckHint(false)).toBe(
      'Shift+click checks the latest RC; Ctrl+click checks the latest perf build.'
    )
  })

  it('formats a compact hint for the width-constrained help menu', () => {
    expect(getUpdateCheckMenuHint(true)).toBe('⇧+click RC · ⌘+click perf')
    expect(getUpdateCheckMenuHint(false)).toBe('Shift+click RC · Ctrl+click perf')
  })
})

// Why: refreshRemoteServerUpdates() forwards only includePrerelease/includePerfPrerelease, so a
// localBuild result there silently degrades to a plain stable check — and a paired Linux server
// has no macOS build at all. The remote surface must neither claim nor produce one.
describe('remote-server update check surface', () => {
  it('omits the local-build gesture from its hint on every platform', () => {
    expect(getRemoteServerUpdateCheckHint(true)).toBe(
      '⇧+click checks servers for the latest RC; ⌘+click checks servers for the latest perf build.'
    )
    expect(getRemoteServerUpdateCheckHint(false)).toBe(
      'Shift+click checks servers for the latest RC; Ctrl+click checks servers for the latest perf build.'
    )
  })

  it('ignores Option instead of collapsing the click to a stable check', () => {
    expect(getRemoteServerUpdateCheckClickOptions(clickEvent({ altKey: true }), true)).toEqual({
      includePrerelease: false,
      includePerfPrerelease: false
    })
    // The app surface would return { localBuild: true } here and drop the Shift request.
    expect(
      getRemoteServerUpdateCheckClickOptions(clickEvent({ altKey: true, shiftKey: true }), true)
    ).toEqual({ includePrerelease: true, includePerfPrerelease: false })
    expect(getUpdateCheckClickOptions(clickEvent({ altKey: true, shiftKey: true }), true)).toEqual({
      localBuild: true
    })
  })
})

describe('update check hint localization', () => {
  afterAll(async () => {
    await i18n.changeLanguage('en')
  })

  it('resolves through i18next rather than a hardcoded literal', async () => {
    const catalog = {
      auto: { lib: { updateCheckClickOptions: { hint: '{{value0}}/{{value1}}' } } }
    }
    i18n.addResourceBundle('zz', 'translation', catalog, true, true)
    await i18n.changeLanguage('zz')

    expect(getUpdateCheckHint(false)).toBe('Shift/Ctrl')
    // Untranslated siblings still fall back to the English source.
    expect(getUpdateCheckMenuHint(false)).toBe('Shift+click RC · Ctrl+click perf')
  })
})
