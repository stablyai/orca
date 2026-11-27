import { expect, it } from 'vitest'
import { buildMirroredBrowserTabs } from './tab-projection/mirrored-browser-tabs'
import { makeSnapshot, makeState, WT } from './testing/web-session-tabs-sync.test-fixture'
import { buildBrowserSessionData } from '../../lib/workspace/persistence/workspace-session-browser-tabs'

it('redacts old-host browser metadata without adopting its bearer as local navigation authority', () => {
  const raw = 'https://kagi.com/search?q=one&token=test-only'
  const snapshot = makeSnapshot([
    {
      type: 'browser',
      id: 'host-tab',
      browserWorkspaceId: 'host-browser',
      browserPageId: 'host-page',
      title: raw,
      url: raw,
      faviconUrl: raw,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      isActive: true,
      loadError: { code: -20, description: 'ERR_BLOCKED_BY_CLIENT', validatedUrl: raw }
    }
  ])
  const [mirrored] = buildMirroredBrowserTabs(
    snapshot,
    'remote-host',
    makeState(),
    new Map(),
    'host-group',
    0,
    1
  )
  expect(mirrored.page).toMatchObject({
    id: 'host-page',
    browserRuntimeEnvironmentId: 'remote-host',
    url: 'https://kagi.com/search?q=one',
    title: 'https://kagi.com/search?q=one',
    faviconUrl: 'https://kagi.com/search?q=one',
    loadError: { validatedUrl: 'https://kagi.com/search?q=one' }
  })
  expect(
    JSON.stringify(
      buildBrowserSessionData(
        { [WT]: [mirrored.workspace] },
        { [mirrored.workspace.id]: [mirrored.page] },
        {},
        {},
        {}
      )
    )
  ).not.toContain('test-only')
})
