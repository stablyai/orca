import { describe, expect, it } from 'vitest'
import { shouldShowBrowserImportHint } from './browser-import-hint-visibility'

describe('shouldShowBrowserImportHint', () => {
  it('shows after persisted UI loads', () => {
    expect(
      shouldShowBrowserImportHint({
        persistedUIReady: true,
        browserImportHintHidden: false
      })
    ).toBe(true)
  })

  it('stays hidden until persisted UI loads', () => {
    expect(
      shouldShowBrowserImportHint({
        persistedUIReady: false,
        browserImportHintHidden: false
      })
    ).toBe(false)
  })

  it('honors explicit hint dismissal', () => {
    expect(
      shouldShowBrowserImportHint({
        persistedUIReady: true,
        browserImportHintHidden: true
      })
    ).toBe(false)
  })
})
