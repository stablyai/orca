import { describe, expect, it } from 'vitest'
import { formatTabReference } from './tab-reference'

describe('formatTabReference', () => {
  it('keeps the orcaTabId line first so earlier references read the same', () => {
    expect(formatTabReference({ unifiedTabId: 'tab-1', kind: 'terminal' }).split('\n')[0]).toBe(
      'orcaTabId: tab-1'
    )
  })

  it('adds the page id the orca tab commands accept for a browser tab', () => {
    expect(
      formatTabReference({ unifiedTabId: 'tab-1', kind: 'browser', browserPageId: 'page-9' })
    ).toBe('orcaTabId: tab-1\ntabKind: browser\nbrowserPageId: page-9')
  })

  it('adds the file path for an editor tab', () => {
    expect(
      formatTabReference({ unifiedTabId: 'tab-2', kind: 'editor', filePath: '/repo/src/a.ts' })
    ).toBe('orcaTabId: tab-2\ntabKind: editor\nfilePath: /repo/src/a.ts')
  })

  it('omits a browser page id that is not known yet', () => {
    expect(
      formatTabReference({ unifiedTabId: 'tab-1', kind: 'browser', browserPageId: null })
    ).toBe('orcaTabId: tab-1\ntabKind: browser')
  })

  it('ignores details that do not belong to the tab kind', () => {
    expect(
      formatTabReference({
        unifiedTabId: 'tab-3',
        kind: 'chat',
        browserPageId: 'page-9',
        filePath: '/repo/a.ts'
      })
    ).toBe('orcaTabId: tab-3\ntabKind: chat')
  })
})
