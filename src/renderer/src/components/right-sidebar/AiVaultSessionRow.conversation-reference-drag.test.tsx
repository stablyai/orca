// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import AiVaultSessionDropLayer from '@/components/tab-group/AiVaultSessionDropLayer'
import { ConversationReferenceChatPane } from '@/components/native-chat/conversation-reference-chat-pane.test-support'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache,
  writeNativeChatDraftCache
} from '@/components/native-chat/native-chat-draft-cache'
import { AI_VAULT_SESSION_DRAG_TYPE } from '@/lib/ai-vault-session-drag'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  CONVERSATION_REFERENCE_DRAG_TYPE,
  conversationReferenceToken,
  conversationReferenceUri
} from '../../../../shared/conversation-reference'
import { VaultSessionRow } from './AiVaultSessionRow'

const launch = vi.hoisted(() => vi.fn())
vi.mock('@/lib/launch-ai-vault-session', () => ({ launchAiVaultSessionInNewTab: launch }))
vi.mock('@/lib/ai-vault-session-resume-preparation', () => ({
  prepareAiVaultTerminalResumeRequest: vi.fn(async () => ({}))
}))
vi.mock('@/lib/ai-vault-resume-target', () => ({
  canResumeAiVaultSessionOnTarget: () => true,
  getAiVaultResumeWorkspaceExecutionHostId: () => 'local',
  getAiVaultResumeWorkspaceTargetStatus: () => 'local'
}))
vi.mock('@/lib/ai-vault-resume-shell', () => ({ getAiVaultResumeWorkspaceWslDistro: () => null }))
vi.mock('@/components/tab-group/ai-vault-pane-drop-target', () => ({
  containsPoint: (rect: DOMRect, x: number, y: number) =>
    x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom,
  resolvePaneDropTarget: () => ({ groupId: 'group-1', zone: 'right', overlayStyle: {} })
}))
vi.mock('@/components/native-chat/NativeChatComposerActions', () => ({
  NativeChatComposerActions: ({ sendDisabled }: { sendDisabled: boolean }) => (
    <button type="button" data-testid="send" disabled={sendDisabled}>
      Send
    </button>
  )
}))
vi.mock('@/components/native-chat/NativeChatAutocompleteMenus', () => ({
  NativeChatMentionMenu: () => null,
  NativeChatPickerMenu: () => null
}))

const reference = {
  uri: conversationReferenceUri('12345678-1234-4234-8234-123456789abc'),
  title: 'History conversation',
  agent: 'claude'
}

const session: AiVaultSession = {
  id: 'local:claude:hist-1:/home/a/.claude/hist-1.jsonl',
  executionHostId: 'local',
  agent: 'claude',
  sessionId: 'hist-1',
  title: 'History conversation',
  cwd: null,
  branch: null,
  model: null,
  filePath: '/home/a/.claude/hist-1.jsonl',
  codexHome: null,
  createdAt: null,
  updatedAt: null,
  modifiedAt: '2026-10-24T00:00:00Z',
  messageCount: 2,
  totalTokens: 0,
  previewMessages: [{ role: 'assistant', text: 'Ready when you are', timestamp: null }],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: 'claude --resume hist-1',
  subagent: null
}

const layerRect = { left: 0, top: 0, right: 400, bottom: 400, width: 400, height: 400 }
const composerRect = { left: 0, top: 300, right: 400, bottom: 400, width: 400, height: 100 }
const overComposer = { clientX: 200, clientY: 350 }
const overPane = { clientX: 200, clientY: 100 }

let create: ReturnType<typeof vi.fn>

/** happy-dom drops DragEventInit's dataTransfer and pointer coordinates, which Chromium keeps and
 *  the composer drop forwarding reads. */
class SpecDragEvent extends window.DragEvent {
  constructor(type: string, init?: DragEventInit) {
    super(type, init)
    Object.defineProperties(this, {
      dataTransfer: { value: init?.dataTransfer ?? null },
      clientX: { value: init?.clientX ?? 0 },
      clientY: { value: init?.clientY ?? 0 }
    })
  }
}

beforeEach(() => {
  vi.stubGlobal('DragEvent', SpecDragEvent)
  create = vi.fn(async () => reference)
  vi.stubGlobal('api', {
    aiVault: {
      createConversationReference: create,
      getFirstUserPrompt: vi.fn().mockResolvedValue({ prompt: null }),
      listSubagentSessions: vi.fn().mockResolvedValue({ sessions: [] })
    },
    ui: { writeTerminalClipboardText: vi.fn() }
  })
  launch.mockReturnValue({ tabId: 'tab-2' })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    const rect = this.matches('[data-ai-vault-session-drop-layer]')
      ? layerRect
      : this.matches('[data-conversation-reference-drop]')
        ? composerRect
        : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
    return new DOMRect(rect.left, rect.top, rect.width, rect.height)
  })
})

afterEach(() => {
  cleanup()
  clearNativeChatDraftCacheForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  launch.mockReset()
})

function renderWorkspace({ hiddenChat = false }: { hiddenChat?: boolean } = {}) {
  return render(
    <TooltipProvider>
      <div className="relative">
        {hiddenChat ? (
          <ConversationReferenceChatPane id="hidden" visible={false} focused={false} />
        ) : (
          <ConversationReferenceChatPane id="a" visible focused />
        )}
        <AiVaultSessionDropLayer worktreeId="wt-1" enabled />
      </div>
      <VaultSessionRow
        session={session}
        liveState={null}
        resumeStartup={{ command: 'claude --resume hist-1' }}
        realHomeResumeStartup={{ command: 'claude --resume hist-1' }}
        worktreeInfo={null}
        vaultScope="all"
        detailsExpanded={false}
        resumeDisabled={false}
        onToggleDetails={() => {}}
        showJumpToWorktree={false}
        onResume={() => {}}
        resumeLabel="Resume"
        resumeActions={{
          worktree: { worktreeId: null, disabled: true },
          newTab: { worktreeId: null, disabled: true }
        }}
        onResumeInWorktree={() => {}}
        onResumeInNewTab={() => {}}
        onCopyId={() => {}}
      />
    </TooltipProvider>
  )
}

function dragHandle(): HTMLElement {
  const handle = screen
    .getByText('History conversation')
    .closest<HTMLElement>('[data-ai-vault-session-drag-handle]')
  expect(handle?.getAttribute('draggable')).toBe('true')
  return handle!
}

/** Starts the row's drag the way the browser does, returning the data it wrote. */
function startDrag(): DataTransfer {
  const data = new DataTransfer()
  const event = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data })
  act(() => {
    dragHandle().dispatchEvent(event)
  })
  expect(event.defaultPrevented).toBe(false)
  return data
}

function drop(target: Element, data: DataTransfer, point: { clientX: number; clientY: number }) {
  act(() => {
    target.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data, ...point })
    )
  })
}

function layer(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-ai-vault-session-drop-layer]')!
}

describe('dragging a session history row', () => {
  it('writes the resume payload and the conversation reference from the header', () => {
    renderWorkspace()
    const data = startDrag()
    expect(Array.from(data.types)).toEqual(
      expect.arrayContaining([AI_VAULT_SESSION_DRAG_TYPE, CONVERSATION_REFERENCE_DRAG_TYPE])
    )
    expect(JSON.parse(data.getData(CONVERSATION_REFERENCE_DRAG_TYPE))).toEqual({
      source: {
        kind: 'transcript',
        agent: 'claude',
        sessionId: 'hist-1',
        filePath: '/home/a/.claude/hist-1.jsonl',
        codexHome: null
      },
      title: 'History conversation',
      executionHostId: 'local'
    })
  })

  it('drops onto the composer as a reference even while the resume layer is on top', async () => {
    writeNativeChatDraftCache('a', 'Keep this draft')
    renderWorkspace()
    const data = startDrag()

    drop(layer(), data, overComposer)

    await waitFor(() =>
      expect(
        screen.getByTestId('chat-a').querySelector('[data-native-chat-conversation-reference]')
          ?.textContent
      ).toBe(reference.title)
    )
    expect(create).toHaveBeenCalledTimes(1)
    expect(launch).not.toHaveBeenCalled()
    expect(readNativeChatDraftCache('a')).toContain('Keep this draft')
    expect(readNativeChatDraftCache('a')).toContain(conversationReferenceToken(reference))
  })

  it('still resumes into a split when dropped on the pane beside the composer', async () => {
    renderWorkspace()
    const data = startDrag()

    drop(layer(), data, overPane)

    await waitFor(() => expect(launch).toHaveBeenCalledTimes(1))
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'wt-1',
        targetGroupId: 'group-1',
        splitDirection: 'right'
      })
    )
    expect(create).not.toHaveBeenCalled()
  })

  it('resumes rather than writing into a hidden chat retained under the drop point', async () => {
    renderWorkspace({ hiddenChat: true })
    const data = startDrag()

    drop(layer(), data, overComposer)

    await waitFor(() => expect(launch).toHaveBeenCalledTimes(1))
    expect(create).not.toHaveBeenCalled()
    expect(readNativeChatDraftCache('hidden')).toBe('')
  })

  it('never starts a drag from a press on the row buttons', () => {
    renderWorkspace()
    fireEvent.pointerDown(within(dragHandle()).getByTestId('ai-vault-session-more-actions'))
    const data = new DataTransfer()
    const event = new DragEvent('dragstart', {
      bubbles: true,
      cancelable: true,
      dataTransfer: data
    })
    act(() => {
      dragHandle().dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(true)
    expect(Array.from(data.types)).toEqual([])
    expect(screen.getByText(/Ready when you are/).closest('[draggable="true"]')).toBeNull()
  })
})
