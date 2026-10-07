// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { NativeChatPaneFileDropSurface } from './NativeChatPaneFileDropSurface'
import { useNativeChatFileDrops } from './use-native-chat-file-drops'

const state = vi.hoisted(() => {
  const tabsByWorktree: Record<string, TerminalTab[]> = {}
  return {
    repos: [],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    sshConnectionStates: new Map(),
    settings: { activeRuntimeEnvironmentId: 'other-remote-runtime' },
    activeWorktreeId: 'other-workspace',
    activeWorkspaceExecutionHostId: 'runtime:other-remote-runtime',
    tabsByWorktree
  }
})
vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const stat = vi.fn(async () => ({ isDirectory: false }))
const prepare = vi.fn(async ({ paths }: { paths: string[] }) => ({ paths, failures: [] }))
const pick = vi.fn(async () => ['/picked/file.txt'])
const upload = vi.fn()

function Composer({ attach, notice }: { attach: () => void; notice: () => void }) {
  const { pickAttachments } = useNativeChatFileDrops({
    paneKey: 'floating-pane',
    draftScopeKey: 'floating-draft',
    terminalTabId: 'floating-tab',
    targetPtyId: 'local-pty',
    disabled: false,
    attachResolvedPaths: attach,
    pendingChips: {
      begin: () => null,
      resolve: () => {},
      drop: () => false,
      attachReferences: () => {}
    },
    setNotice: notice
  })
  return <button onClick={pickAttachments}>Attach file</button>
}

beforeEach(() => {
  vi.clearAllMocks()
  state.tabsByWorktree = {
    [FLOATING_TERMINAL_WORKTREE_ID]: [
      {
        id: 'floating-tab',
        ptyId: 'local-pty',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        title: 'Floating',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 0
      }
    ]
  }
  vi.stubGlobal('api', {
    fs: {
      getPathForFile: (file: File) => `/drop/${file.name}`,
      stat,
      prepareDroppedPaths: prepare,
      resolveDroppedPathsForAgent: upload
    },
    shell: { pickAttachments: pick }
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('floating chat attachments with a different remote runtime focused', () => {
  it.each(['drop', 'paperclip'] as const)(
    'attaches a local file through %s without catalog rows',
    async (lane) => {
      const attach = vi.fn()
      const notice = vi.fn()
      const view = render(
        <NativeChatPaneFileDropSurface className="chat">
          <Composer attach={attach} notice={notice} />
        </NativeChatPaneFileDropSurface>
      )
      if (lane === 'paperclip') {
        await act(async () => fireEvent.click(view.getByText('Attach file')))
      } else {
        const transfer = {
          types: ['Files'],
          files: [new File(['x'], 'file.txt')],
          dropEffect: 'none'
        }
        await act(async () => {
          for (const type of ['dragover', 'drop']) {
            const event = new Event(type, { bubbles: true, cancelable: true, composed: true })
            Object.defineProperty(event, 'isTrusted', { value: true })
            Object.defineProperty(event, 'dataTransfer', { value: transfer })
            view.getByText('Attach file').dispatchEvent(event)
            if (type === 'dragover') {
              expect(transfer.dropEffect).toBe('copy')
            }
          }
        })
      }
      const path = lane === 'drop' ? '/drop/file.txt' : '/picked/file.txt'
      expect(stat).toHaveBeenCalledExactlyOnceWith({
        filePath: path,
        access: { kind: 'user-file' }
      })
      expect(attach).toHaveBeenCalledExactlyOnceWith([path], undefined, {
        destinationIsCurrent: expect.any(Function)
      })
      expect(attach.mock.calls[0][2].destinationIsCurrent()).toBe(true)
      expect(upload).not.toHaveBeenCalled()
      expect(notice).not.toHaveBeenCalled()
    }
  )
})
