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
  expect(error).toMatchObject({ display: { kind: 'not-web-link' } })
  expect(openFailureDetail(error)).not.toBeNull()
})

it('a click superseded while its open was failing stays silent', async () => {
  // Current when the open starts, stale by the time it fails.
  let checks = 0
  await expect(
    openWorkspaceBrowserTabForLink({
      workspaceId: 'wt',
      url: 'not a url',
      intent: { kind: 'url' },
      linkContext: { linkIntent: null, isCurrentRequest: () => checks++ === 0 }
    })
  ).resolves.toEqual({ status: 'superseded' })
})
