import { expect, it, vi } from 'vitest'

vi.mock('@/store/index', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

const { openWorkspaceBrowserTabForLink } = await import('./workspace-browser-tab-open')
const { openFailureDetail } = await import('./workspace-browser-tab-presentation')

it('a clicked link that fails keeps its reason for the toast', async () => {
  const opening = openWorkspaceBrowserTabForLink({
    workspaceId: 'wt',
    url: 'not a url',
    intent: { kind: 'url' },
    linkContext: { linkIntent: null, isCurrentRequest: () => true }
  })
  const error = await opening.then(
    () => null,
    (reason: unknown) => reason
  )
  expect(openFailureDetail(error)).toContain('target is not an http(s) URL')
})

it('a superseded click stays silent', async () => {
  await expect(
    openWorkspaceBrowserTabForLink({
      workspaceId: 'wt',
      url: 'not a url',
      intent: { kind: 'url' },
      linkContext: { linkIntent: null, isCurrentRequest: () => false }
    })
  ).resolves.toEqual({ status: 'superseded' })
})
