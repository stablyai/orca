// L284: a frame that draws a server tab for a page this desktop staged takes the create over.
import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetStagedBrowserFrameHandoversForTests,
  wasStagedBrowserTabHandedToFrames
} from '@/lib/staged-browser-frame-handover'
import { noteFramesTakingOverStagedBrowserTabs } from './workspace-layout-frame-browser-handover'

const ENV = 'env-1'

function records(
  workspaceId: string,
  pageId: string,
  handle: { remotePageId: string; staged?: true }
) {
  return {
    browserPagesByWorkspace: { [workspaceId]: [{ id: pageId }] },
    remoteBrowserPageHandlesByPageId: {
      [pageId]: { ...handle, environmentId: ENV }
    }
  }
}

afterEach(() => _resetStagedBrowserFrameHandoversForTests())

describe("a frame drawing the server's tab for a staged page", () => {
  it('records the handover when the staged tab drops and the same page is drawn', () => {
    const state = records('staged-ws', 'staged-page', { remotePageId: 'page-1', staged: true })
    // The frame's page has the server's id and, at this point, no handle.
    const built = { browserPagesByWorkspace: { 'server-ws': [{ id: 'page-1' }] } }

    noteFramesTakingOverStagedBrowserTabs(state, built, ['staged-ws'], new Set(['server-ws']))

    expect(wasStagedBrowserTabHandedToFrames('staged-ws', 'page-1')).toBe(true)
  })

  it.each([
    ['the dropped tab was not staged', { remotePageId: 'page-1' }, 'server-ws', 'page-1'],
    [
      'the frame drew another page',
      { remotePageId: 'page-1', staged: true },
      'server-ws',
      'page-2'
    ],
    ['no drawn tab holds the page', { remotePageId: 'page-1', staged: true }, 'other-ws', 'page-1']
  ] as const)('records nothing when %s', (_, stagedHandle, builtTab, builtPage) => {
    const state = records('staged-ws', 'staged-page', stagedHandle)
    const built = { browserPagesByWorkspace: { [builtTab]: [{ id: builtPage }] } }

    noteFramesTakingOverStagedBrowserTabs(state, built, ['staged-ws'], new Set(['server-ws']))

    expect(wasStagedBrowserTabHandedToFrames('staged-ws', 'page-1')).toBe(false)
  })
})
