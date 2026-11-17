import { describe, expect, it, vi } from 'vitest'
import '@/lib/workspace/activation/worktree-activation'
import { createTerminalLinkTestDoubles } from '@/components/terminal-pane/links/terminal-link-handlers-test-fixtures'
import {
  flushAsyncWork,
  installTerminalLinkTestEnvironment,
  setPlatform
} from '@/components/terminal-pane/links/terminal-link-handlers-test-harness'
import { createNativeChatFileHref } from '../../../../../../shared/native-chat/file-access/native-chat-href-routing'
import { createNativeChatExplicitFileOpener } from './use-native-chat-file-link-click'
import type * as FilePreview from '@/lib/browser/documents/file-preview'

type FilePreviewModule = typeof FilePreview

const canShowBrowserMock = vi.hoisted(() => vi.fn())
const plannedBrowserOpenMock = vi.hoisted(() => vi.fn())
const toastErrorMock = vi.hoisted(() => vi.fn())
const doubles = createTerminalLinkTestDoubles()
const { storeState, openFileForLinkMock } = doubles

vi.mock('@/store/index', () => ({ useAppStore: { getState: () => storeState } }))
vi.mock('sonner', () => ({ toast: { error: toastErrorMock } }))
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))
vi.mock('@/lib/workspace/ownership/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))
vi.mock('@/lib/browser/documents/file-preview', async (importOriginal) => ({
  ...(await importOriginal<FilePreviewModule>()),
  canShowWorkspaceFileBrowserAction: canShowBrowserMock
}))
vi.mock('@/lib/browser/documents/file-preview-link-open', () => ({
  openPlannedFileBrowserLink: plannedBrowserOpenMock
}))
vi.mock('@/lib/workspace/creation/surface-policy/client-creation-action-policy', () => ({
  getWorkspaceClientCreationActionPolicy: () => ({ 'managed-browser': { state: 'enabled' } })
}))

installTerminalLinkTestEnvironment(doubles)

const context = {
  worktreeId: 'wt-1',
  worktreePath: '/tmp',
  runtimeEnvironmentId: null,
  sourceTabId: 'chat-1'
}
const pageHref = createNativeChatFileHref('site/index.html', 'literal')

function clickCard(href: string): void {
  // As the card does: the label was rendered earlier; the destination is read at the click.
  const opener = createNativeChatExplicitFileOpener(context)
  opener.open(href, { destination: opener.destinationFor(href) })
}

describe.each(['none', 'actions', 'open'] as const)(
  'explicit chat file open with link clicks set to %s',
  (terminalLinkClickBehavior) => {
    function seed(): void {
      setPlatform('Macintosh')
      storeState.settings = { terminalLinkClickBehavior }
      plannedBrowserOpenMock.mockResolvedValue({ status: 'opened', result: {} })
    }

    it('opens a page the workspace can show in the Orca Browser, asking for a fresh reused page', async () => {
      seed()
      canShowBrowserMock.mockReturnValue(true)
      clickCard(pageHref)
      await flushAsyncWork()

      expect(plannedBrowserOpenMock).toHaveBeenCalledTimes(1)
      expect(plannedBrowserOpenMock.mock.calls[0]?.[1]).toMatchObject({
        filePath: '/tmp/site/index.html',
        worktreeId: 'wt-1'
      })
      expect(plannedBrowserOpenMock.mock.calls[0]?.[3]).toMatchObject({ refreshReusedPage: true })
      expect(openFileForLinkMock).not.toHaveBeenCalled()
    })

    it('opens the HTML source in the editor once the capability is gone at the click', async () => {
      seed()
      canShowBrowserMock.mockReturnValue(true)
      const opener = createNativeChatExplicitFileOpener(context)
      expect(opener.destinationFor(pageHref)).toBe('orca-browser')
      canShowBrowserMock.mockReturnValue(false)
      opener.open(pageHref, { destination: opener.destinationFor(pageHref) })
      await flushAsyncWork()

      expect(plannedBrowserOpenMock).not.toHaveBeenCalled()
      expect(openFileForLinkMock.mock.calls[0]?.[0]).toMatchObject({
        filePath: '/tmp/site/index.html',
        worktreeId: 'wt-1',
        language: 'html',
        mode: 'edit'
      })
    })

    it.each(['refused', 'unsupported'] as const)(
      'reports a %s browser open and does not open the editor instead',
      async (status) => {
        seed()
        canShowBrowserMock.mockReturnValue(true)
        plannedBrowserOpenMock.mockResolvedValue({ status })
        clickCard(pageHref)
        await flushAsyncWork()

        expect(toastErrorMock).toHaveBeenCalledWith("Couldn't open index.html in the Orca Browser")
        expect(openFileForLinkMock).not.toHaveBeenCalled()
      }
    )
  }
)
