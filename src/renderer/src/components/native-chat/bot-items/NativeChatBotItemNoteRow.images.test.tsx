// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { resetLocalImageCacheState } from '@/components/editor/document-images/local-image-src-cache'
import { NativeChatMarkdownImageOwnerContext } from '../media/images/native-chat-markdown-image-owner'
import { NativeChatBotItemNoteRow } from './NativeChatBotItemNoteRow'

const mocks = vi.hoisted(() => ({ readRuntimeFilePreview: vi.fn() }))
vi.mock('@/runtime/files/reads/runtime-file-read-client', () => ({
  readRuntimeFilePreview: mocks.readRuntimeFilePreview
}))

const NAME = 'orca-paste-1795249642147-d98b00d6.png'
const PATH = `/Users/me/Library/Application Support/orca/agent-session-attachments/32871f48-f06a-4495-8665-2a3592d42550/${NAME}`

const owner = {
  fileLinkContext: null,
  runtimeContext: {
    target: { kind: 'local' as const },
    worktreeId: 'wt-1',
    worktreePath: '/repo/worktree',
    expectedExecutionHostId: 'local' as const
  },
  isVisible: true,
  sessionId: 'session-1'
}

function OwnerComment(): React.JSX.Element {
  return (
    <TooltipProvider>
      <NativeChatMarkdownImageOwnerContext.Provider value={owner}>
        <NativeChatBotItemNoteRow
          note={{
            noteId: 'm1',
            by: 'owner',
            entries: [
              {
                uid: 'item-1',
                number: 317,
                title: 'Two GitHub accounts',
                status: 'working',
                event: 'commented',
                text: '[Image #1] does slack have this too',
                images: [{ path: PATH, name: NAME, bytes: 151_703 }]
              }
            ]
          }}
        />
      </NativeChatMarkdownImageOwnerContext.Provider>
    </TooltipProvider>
  )
}

beforeEach(() => {
  resetLocalImageCacheState()
  // No observer: every tile counts as near the viewport.
  vi.stubGlobal('IntersectionObserver', undefined)
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:comment-image')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  mocks.readRuntimeFilePreview.mockReset()
})

afterEach(() => {
  cleanup()
  resetLocalImageCacheState()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it("reads an item comment's failed image again when the window is shown without focus, with no file-name caption", async () => {
  mocks.readRuntimeFilePreview
    .mockRejectedValueOnce(new Error('EBUSY'))
    .mockResolvedValue({ content: 'AA==', isBinary: true, mimeType: 'image/png' })
  render(<OwnerComment />)

  await waitFor(() => expect(mocks.readRuntimeFilePreview).toHaveBeenCalledTimes(1))
  expect(document.querySelector('img')).toBeNull()

  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
  document.dispatchEvent(new Event('visibilitychange'))
  await waitFor(() =>
    expect(document.querySelector('img')?.getAttribute('src')).toBe('blob:comment-image')
  )
  expect(document.querySelector('img')?.getAttribute('alt')).toBe(NAME)
  expect(screen.queryByText(NAME)).toBeNull()
  expect(screen.getByText('does slack have this too')).not.toBeNull()
})
