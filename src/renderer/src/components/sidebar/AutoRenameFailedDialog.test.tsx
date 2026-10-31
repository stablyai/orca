// @vitest-environment happy-dom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNativeChatNamingFailure } from '../tab-bar/use-native-chat-naming-failure'
import { NameGenerationFailedDialog, AutoRenameFailedDialog } from './AutoRenameFailedDialog'
import { useAppStore } from '@/store'
import { toast } from 'sonner'
import type { AppState } from '@/store/types'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

vi.mock('@/runtime/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapabilityState: () => 'unsupported'
}))
vi.mock('@/runtime/structured-agent-session-status-feed', () => ({
  getStructuredAgentSessionStatusFeed: () => null
}))
function ChatFailure({ failedAt }: { failedAt: number }) {
  const controls = useNativeChatNamingFailure({
    executionHostId: 'local',
    sessionId: 'chat',
    error: { message: 'No name', failedAt }
  })
  return (
    controls && (
      <NameGenerationFailedDialog
        open
        onOpenChange={() => {}}
        title="Chat name"
        description="Failure"
        error={controls.message}
        readFullOutput={controls.readFullOutput}
      />
    )
  )
}

const getBranchRenameFailureOutput =
  vi.fn<(args: { worktreeId: string }) => Promise<string | null>>()
const writeClipboardText = vi.fn<(text: string) => Promise<void>>()
const updateWorktreeMeta = vi.fn<AppState['updateWorktreeMeta']>()
const realUpdateWorktreeMeta = useAppStore.getState().updateWorktreeMeta
const updateMeta = vi.fn<() => Promise<void>>()

function WorkspaceFailure() {
  const worktree = useAppStore((s) => s.worktreesByRepo.repo1?.[0])
  const [open, setOpen] = useState(true)
  return worktree?.firstAgentMessageRenameError ? (
    <>
      <span>rename failed</span>
      <AutoRenameFailedDialog
        open={open}
        onOpenChange={setOpen}
        worktreeId={worktree.id}
        executionHostId="local"
        worktreeName={worktree.displayName}
        error={worktree.firstAgentMessageRenameError}
      />
    </>
  ) : null
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  useAppStore.setState({ updateWorktreeMeta })
  ;(window as unknown as { api: unknown }).api = {
    worktrees: { getBranchRenameFailureOutput, updateMeta },
    nativeChat: { getConversationNameFailureOutput: getBranchRenameFailureOutput },
    ui: { writeClipboardText }
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  document.body.innerHTML = ''
})

const EXCERPT_ERROR = 'Pi CLI command failed with code 1: No API key found for github-copilot.'

const onOpenChange = vi.fn<(open: boolean) => void>()

async function renderDialog(error = EXCERPT_ERROR): Promise<void> {
  await act(async () => {
    root.render(
      <AutoRenameFailedDialog
        open
        onOpenChange={onOpenChange}
        worktreeId="wt-1"
        executionHostId="ssh:builder"
        worktreeName="staghorn"
        error={error}
      />
    )
  })
}

describe('AutoRenameFailedDialog dismissal', () => {
  it('keeps Close temporary and persists Dismiss error on the workspace owner', async () => {
    getBranchRenameFailureOutput.mockResolvedValue(null)
    updateWorktreeMeta.mockResolvedValue({ ok: true })
    await renderDialog()
    const footer = document.querySelector('[data-slot="dialog-footer"]')
    await act(async () => footer?.querySelector<HTMLButtonElement>('button')?.click())
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(updateWorktreeMeta).not.toHaveBeenCalled()
    onOpenChange.mockClear()

    await act(async () => {
      const dismiss = Array.from(document.querySelectorAll('button')).find(
        (button) => button.getAttribute('aria-label') === 'Dismiss error'
      )
      dismiss?.click()
    })

    expect(updateWorktreeMeta).toHaveBeenCalledWith(
      'wt-1',
      { firstAgentMessageRenameError: null },
      { executionHostId: 'ssh:builder' }
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it.each([true, false])(
    'keeps the real store error visible until its save succeeds (%s)',
    async (succeeds) => {
      getBranchRenameFailureOutput.mockResolvedValue(null)
      const worktree = makeWorktree({
        id: 'repo1::/path/wt1',
        repoId: 'repo1',
        firstAgentMessageRenameError: EXCERPT_ERROR
      })
      const save = Promise.withResolvers<void>()
      updateMeta.mockReturnValue(save.promise)
      useAppStore.setState({
        updateWorktreeMeta: realUpdateWorktreeMeta,
        worktreesByRepo: { repo1: [worktree] },
        fetchWorktrees: vi.fn().mockResolvedValue(false)
      })
      await act(async () => root.render(<WorkspaceFailure />))
      const dismiss = Array.from(document.querySelectorAll('button')).find(
        (button) => button.getAttribute('aria-label') === 'Dismiss error'
      )
      await act(async () => dismiss?.click())
      expect(dismiss?.disabled).toBe(true)
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(EXCERPT_ERROR)
      expect(container.textContent).toContain('rename failed')

      await act(async () =>
        succeeds ? save.resolve() : save.reject(new Error('Server disconnected'))
      )

      if (succeeds) {
        expect(document.querySelector('[role="dialog"]')).toBeNull()
        expect(container.textContent).not.toContain('rename failed')
        expect(
          useAppStore.getState().worktreesByRepo.repo1[0]?.firstAgentMessageRenameError
        ).toBeNull()
      } else {
        expect(toast.error).toHaveBeenCalledWith('Server disconnected')
        expect(dismiss?.disabled).toBe(false)
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain(EXCERPT_ERROR)
        expect(container.textContent).toContain('rename failed')
      }
    }
  )
})

describe('AutoRenameFailedDialog full output', () => {
  it('shows the full CLI output fetched from main when available', async () => {
    getBranchRenameFailureOutput.mockResolvedValueOnce(
      'Pi exited with code 1.\n\n[stderr]\nNo API key found for github-copilot.\nUse /login to log in.'
    )
    await renderDialog()
    expect(getBranchRenameFailureOutput).toHaveBeenCalledWith({ worktreeId: 'wt-1' })
    expect(document.body.textContent).toContain('[stderr]')
    expect(document.body.textContent).toContain('Use /login to log in.')
  })

  it('refreshes and copies a new chat diagnostic while its identical-message dialog stays open', async () => {
    getBranchRenameFailureOutput.mockResolvedValueOnce('run A output')
    await act(async () => root.render(<ChatFailure failedAt={1} />))
    expect(document.body.textContent).toContain('run A output')
    getBranchRenameFailureOutput.mockResolvedValueOnce('run B output')
    await act(async () => root.render(<ChatFailure failedAt={2} />))
    expect(document.body.textContent).not.toContain('run A output')
    expect(document.body.textContent).toContain('run B output')
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Copy error"]')?.click()
    )
    expect(writeClipboardText).toHaveBeenCalledWith('run B output')
  })

  it('falls back to the persisted excerpt when main holds no capture', async () => {
    getBranchRenameFailureOutput.mockResolvedValueOnce(null)
    await renderDialog()
    expect(document.body.textContent).toContain(EXCERPT_ERROR)
  })

  it('falls back to the persisted excerpt when the fetch rejects', async () => {
    getBranchRenameFailureOutput.mockRejectedValueOnce(new Error('ipc unavailable'))
    await renderDialog()
    expect(document.body.textContent).toContain(EXCERPT_ERROR)
  })

  it('refetches full output when a retry changes the persisted error', async () => {
    getBranchRenameFailureOutput.mockResolvedValueOnce('first run full output')
    await renderDialog('first run excerpt')
    expect(document.body.textContent).toContain('first run full output')

    getBranchRenameFailureOutput.mockResolvedValueOnce('second run full output')
    await renderDialog('second run excerpt')

    expect(getBranchRenameFailureOutput).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain('second run full output')
    expect(document.body.textContent).not.toContain('first run full output')
  })
})

// happy-dom has no intrinsic sizing; verify the declarations that contain unbroken output.
describe('AutoRenameFailedDialog unbroken output containment', () => {
  it('keeps the output surface shrinkable and breakable mid-token', async () => {
    getBranchRenameFailureOutput.mockResolvedValueOnce(`{"error":"${'A'.repeat(1000)}"}`)
    await renderDialog()

    const dialog = document.querySelector('[role="dialog"]')
    const output = dialog?.querySelector('pre')
    expect(output).toBeTruthy()
    expect(output?.textContent).toContain('A'.repeat(1000))

    // break-word preserves token min-content width; anywhere shrinks it.
    expect(output?.className).toContain('[overflow-wrap:anywhere]')
    expect(output?.className).not.toContain('break-words')

    // Grid children need min-w-0 to shrink below min-content.
    const gridChild = Array.from(dialog?.children ?? []).find((child) =>
      child.contains(output ?? null)
    )
    expect(gridChild?.className).toContain('min-w-0')
  })
})
