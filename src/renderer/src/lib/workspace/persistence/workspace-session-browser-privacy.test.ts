import { expect, it } from 'vitest'
import { buildBrowserSessionData } from './workspace-session-browser-tabs'
import { planBrowserPageConversion } from '../../../store/slices/browser/pages/browser-page-conversion'
import { takeKagiPrivateInitialNavigation } from '../../kagi-private-initial-navigation'
import {
  browserPageSchema,
  browserWorkspaceSchema,
  browserHistoryEntriesSchema
} from '../../../../../shared/workspace-session/workspace-session-browser-schema'
import {
  displayableFaviconUrl,
  remoteTabFaviconUrl
} from '../../../../../shared/browser/browser-favicon-url'

const raw = 'https://kagi.com/search?q=one&token=test-only#result'
const safe = 'https://kagi.com/search?q=one#result'
const metadata = {
  url: raw,
  title: raw,
  faviconUrl: raw,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  loadError: { code: -20, description: 'ERR_BLOCKED_BY_CLIENT', validatedUrl: raw },
  createdAt: 1
}
const page = {
  ...metadata,
  id: 'page',
  workspaceId: 'browser',
  worktreeId: 'folder',
  convertedFrom: { kind: 'url' as const, url: raw },
  convertedTo: { kind: 'url' as const, url: raw }
}
const workspace = {
  ...metadata,
  id: 'browser',
  worktreeId: 'folder',
  activePageId: 'page',
  pageIds: ['page']
}

it('redacts tainted browser chrome and conversion URLs on serialization and legacy restore', () => {
  const serialized = buildBrowserSessionData(
    { folder: [workspace] },
    { browser: [page] },
    {},
    {},
    {}
  )
  expect(JSON.stringify(serialized)).not.toContain('test-only')
  expect(serialized.browserPagesByWorkspace?.browser[0]).toMatchObject({
    url: safe,
    title: safe,
    faviconUrl: safe,
    loadError: { validatedUrl: safe },
    convertedFrom: { kind: 'url', url: safe },
    convertedTo: { kind: 'url', url: safe }
  })
  expect(browserPageSchema.parse(page)).toMatchObject({
    url: safe,
    faviconUrl: safe,
    convertedTo: { url: safe }
  })
  expect(browserWorkspaceSchema.parse(workspace)).toMatchObject({
    url: safe,
    title: safe,
    loadError: { validatedUrl: safe }
  })
  expect(
    browserPageSchema.parse({
      ...page,
      convertedFrom: {
        kind: 'workspace-doc',
        docLocation: { kind: 'workspace-doc', worktreeId: 'folder', filePath: '/report.html' }
      }
    }).convertedFrom
  ).toEqual({
    kind: 'workspace-doc',
    docLocation: { kind: 'workspace-doc', worktreeId: 'folder', filePath: '/report.html' }
  })
})

it('cleans legacy URL-valued history titles and favicons before they can be fetched or saved again', () => {
  expect(
    browserHistoryEntriesSchema.parse([
      { url: raw, normalizedUrl: raw, title: raw, faviconUrl: raw, lastVisitedAt: 1, visitCount: 1 }
    ])
  ).toEqual([
    {
      url: safe,
      normalizedUrl: safe,
      title: safe,
      faviconUrl: safe,
      lastVisitedAt: 1,
      visitCount: 1
    }
  ])
  expect(displayableFaviconUrl(raw)).toBe(safe)
  expect(remoteTabFaviconUrl(raw)).toBe(safe)
  expect(displayableFaviconUrl('data:image/png;base64,abc')).toBe('data:image/png;base64,abc')
  expect(remoteTabFaviconUrl('https://example.com/icon.png')).toBe('https://example.com/icon.png')
})

it('cleans admitted schemeless Kagi destinations and titles before saving a cold page', () => {
  const tainted = {
    ...page,
    url: 'kagi.com/search?token=test-only&q=one',
    title: 'kagi.com/search?token=test-only&q=one'
  }
  const serialized = buildBrowserSessionData({}, { browser: [tainted] }, {}, {}, {})
  expect(serialized.browserPagesByWorkspace?.browser[0]).toMatchObject({
    url: 'https://kagi.com/search?q=one',
    title: 'https://kagi.com/search?q=one'
  })
  expect(JSON.stringify(serialized)).not.toContain('test-only')
})

it('keeps document conversion and both history legs credential-free without replaying a bearer', () => {
  const docLocation = {
    kind: 'workspace-doc' as const,
    worktreeId: 'folder',
    filePath: '/report.html'
  }
  const state = {
    browserTabsByWorktree: { folder: [workspace] },
    browserPagesByWorkspace: {
      browser: [{ ...page, url: '', docLocation, convertedFrom: undefined, convertedTo: undefined }]
    }
  }
  const converted = planBrowserPageConversion(state, 'page', { kind: 'web', url: raw })
  expect(converted?.newPage.url).toBe(safe)
  expect(converted?.newPage.convertedFrom).toEqual({ kind: 'workspace-doc', docLocation })
  expect(takeKagiPrivateInitialNavigation(converted?.newPage.id ?? '', safe)).toBe(safe)
  if (!converted) {
    throw new Error('Expected document conversion')
  }

  const back = planBrowserPageConversion(
    {
      browserTabsByWorktree: { folder: [converted.nextWorkspace] },
      browserPagesByWorkspace: { browser: [{ ...converted.newPage, url: raw }] }
    },
    converted.newPage.id,
    { kind: 'workspace-doc', docLocation },
    { leg: 'history-return' }
  )
  expect(back?.newPage.convertedTo).toEqual({
    kind: 'url',
    url: safe,
    browserRuntimeEnvironmentId: null
  })
  if (!back) {
    throw new Error('Expected Back conversion')
  }
  const forward = planBrowserPageConversion(
    {
      browserTabsByWorktree: { folder: [back.nextWorkspace] },
      browserPagesByWorkspace: { browser: back.nextPages }
    },
    back.newPage.id,
    { kind: 'web', url: raw },
    { leg: 'history-advance' }
  )
  expect(forward?.newPage.url).toBe(safe)
  expect(forward?.newPage.convertedFrom).toEqual({ kind: 'workspace-doc', docLocation })
  const serialized = buildBrowserSessionData(
    { folder: [back.nextWorkspace] },
    { browser: back.nextPages },
    {},
    {},
    {}
  )
  expect(JSON.stringify(serialized)).not.toContain('test-only')
})
