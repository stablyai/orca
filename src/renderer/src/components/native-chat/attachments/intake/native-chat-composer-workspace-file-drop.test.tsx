// @vitest-environment happy-dom

import type * as AttachmentOwnerModule from '../uploads/native-chat-attachment-owner'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useLayoutEffect, useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  encodeWorkspaceFilePaths,
  WORKSPACE_FILE_PATHS_MIME,
  WORKSPACE_FILE_PATH_MIME,
  writeWorkspaceFileDragSource
} from '@/lib/workspace-file-drag'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'

import type { NativeChatComposerInput } from '../../composer/editor/native-chat-composer-input'
import { NativeChatComposerField } from '../../composer/editor/NativeChatComposerField'
import { useNativeChatComposerAttachments } from '../chips/use-native-chat-composer-attachments'
import { useNativeChatWorkspaceFileDrop } from './use-native-chat-workspace-file-drop'
import { useImeEnterGestureOwnership } from '@/lib/ime-composition-keyboard-event'
import type * as RemoteRuntimePtyIdModule from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'

const testState: {
  executionHostId: ExecutionHostId
  ownerKind: 'local' | 'not-ready' | 'remote'
  targetIsRemoteRuntime: boolean
  store: { tabsByWorktree: Record<string, { id: string }[]> }
} = vi.hoisted(() => ({
  executionHostId: 'local',
  ownerKind: 'local',
  targetIsRemoteRuntime: false,
  store: {
    tabsByWorktree: {
      'worktree-1': [{ id: 'terminal-tab-1' }]
    }
  }
}))

vi.mock('@/store', () => {
  const useAppStore = (selector: (state: typeof testState.store) => unknown) =>
    selector(testState.store)
  useAppStore.getState = () => testState.store
  return { useAppStore }
})
vi.mock('@/lib/workspace/ownership/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => testState.executionHostId
}))
// Retain production notices and exports so mocks cannot hide stale wording or new behavior.
vi.mock('../uploads/native-chat-attachment-owner', async (importOriginal) => ({
  ...(await importOriginal<typeof AttachmentOwnerModule>()),
  resolveNativeChatAttachmentHost: () => testState.executionHostId,
  resolveNativeChatAttachmentOwnerForWorktree: () => ({ kind: testState.ownerKind })
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock(
  '../../../../../../shared/remote-runtime/remote-runtime-pty-id',
  async (importOriginal) => ({
    ...(await importOriginal<typeof RemoteRuntimePtyIdModule>()),
    isRemoteRuntimePtyId: () => testState.targetIsRemoteRuntime
  })
)
vi.mock('../../composer/controls/NativeChatComposerActions', () => ({
  NativeChatComposerActions: () => <div data-testid="composer-actions" />
}))
vi.mock('../../composer/pickers/NativeChatAutocompleteMenus', () => ({
  NativeChatMentionMenu: () => null,
  NativeChatPickerMenu: () => null
}))
vi.mock('../chips/NativeChatImageAttachmentPreview', () => ({
  NativeChatImageAttachmentPreview: ({
    attachment
  }: {
    attachment: { connectionId?: string; path: string }
  }) => (
    <output data-image-attachment data-connection-id={attachment.connectionId}>
      {attachment.path}
    </output>
  )
}))

class FileDragDataTransfer {
  // Seed a distinct browser default so assertions prove both copy and refusal verdicts were written.
  dropEffect = 'link'
  effectAllowed = 'copyMove'
  files: File[] = []
  private readonly data = new Map<string, string>()

  get types(): string[] {
    return [...this.data.keys()]
  }

  getData(type: string): string {
    return this.data.get(type) ?? ''
  }

  setData(type: string, value: string): void {
    this.data.set(type, value)
  }
}

type ProbeProps = {
  disabled?: boolean
  initialDraft?: string
  structured?: boolean
  /** Overrides only the structured target, leaving the pane's scope key alone. */
  structuredWorkspaceId?: string
  workspaceId?: string
}

let latestInput: NativeChatComposerInput | null = null
const bubbledDrop = vi.fn()

function ComposerProbe({
  disabled = false,
  initialDraft = '',
  structured = true,
  structuredWorkspaceId,
  workspaceId = 'worktree-1'
}: ProbeProps): React.JSX.Element {
  const [draft, setDraft] = useState(initialDraft)
  const [caret, setCaret] = useState(initialDraft.length)
  const [notice, setNotice] = useState<string | null>(null)
  const inputRef = useRef<NativeChatComposerInput>(null)
  const imeEnterGesture = useImeEnterGestureOwnership()
  const attachments = useNativeChatComposerAttachments({
    attachmentScopeKey: `pane:${workspaceId}`,
    allowWithoutTarget: structured,
    imageReferences: structured,
    caret,
    disabled,
    isComposing: imeEnterGesture.isComposing,
    resolveTarget: () =>
      structured ? null : { ptyId: 'pty-1', settings: { activeRuntimeEnvironmentId: null } },
    textareaRef: inputRef,
    setCaret,
    setDraft,
    setNotice
  })
  const workspaceFileDropHandlers = useNativeChatWorkspaceFileDrop({
    terminalTabId: 'terminal-tab-1',
    structuredWorktreeId: structured ? (structuredWorkspaceId ?? workspaceId) : undefined,
    disabled,
    attachResolvedPaths: attachments.attachResolvedPaths,
    setNotice
  })
  useLayoutEffect(() => {
    latestInput = inputRef.current
  })

  return (
    <div onDrop={bubbledDrop}>
      {/* Mount pane drop handlers on a bare wrapper to isolate the attachment route. */}
      <div {...workspaceFileDropHandlers}>
        <NativeChatComposerField
          draftScopeKey={`pane:${workspaceId}`}
          textareaRef={inputRef}
          draft={draft}
          disabled={disabled}
          hasPty
          canSend={!disabled}
          autocomplete={{ mode: 'none' }}
          activeSuggestion={0}
          notices={notice ? [{ key: 'composer', kind: 'attachment', text: notice }] : []}
          imageAttachments={attachments.imageAttachments}
          sendButtonDisabled={false}
          isWorking={false}
          attachDisabled={disabled}
          dictationDisabled
          isDictating={false}
          isDictationHoldMode={false}
          imeEnterGesture={imeEnterGesture}
          onDraftChange={(value, input) => {
            setDraft(value)
            setCaret(input.selectionStart ?? value.length)
          }}
          onTextareaSelect={(input) => setCaret(input.selectionStart ?? input.value.length)}
          onKeyDown={() => {}}
          onImeSettled={(input) => {
            setDraft(input.value)
            attachments.flushPendingAttachments()
          }}
          onPaste={() => {}}
          pickerListboxId="picker"
          onChoosePickerItem={() => {}}
          onRetrySkills={() => {}}
          onChooseMentionFile={() => {}}
          mentionFiles={{ files: [], loading: false, failed: false }}
          onRemoveImageAttachment={attachments.removeImageAttachment}
          onAttach={() => {}}
          onDictationToggle={() => {}}
          onDictationHoldStart={() => {}}
          onDictationHoldEnd={() => {}}
          onSend={() => {}}
          sessionOptionsSurface={null}
          sessionOptionsSnapshot={[]}
        />
      </div>
      <output data-testid="draft">{draft}</output>
    </div>
  )
}

function internalTransfer(
  paths: string[],
  source: { executionHostId?: ExecutionHostId; workspaceId?: string } = {}
): FileDragDataTransfer {
  const transfer = new FileDragDataTransfer()
  transfer.setData(WORKSPACE_FILE_PATH_MIME, paths[0] ?? '')
  if (paths.length > 1) {
    transfer.setData(WORKSPACE_FILE_PATHS_MIME, encodeWorkspaceFilePaths(paths))
  }
  writeWorkspaceFileDragSource(transfer, {
    executionHostId: source.executionHostId ?? 'local',
    workspaceId: source.workspaceId ?? 'worktree-1'
  })
  return transfer
}

function editor(): HTMLElement {
  return screen.getByRole('textbox')
}

function dispatchDragEvent(
  type: 'dragover' | 'drop',
  target: Element,
  dataTransfer: FileDragDataTransfer
): boolean {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  let accepted = true
  act(() => {
    accepted = target.dispatchEvent(event)
  })
  return accepted
}

describe('native chat workspace file drops', () => {
  beforeEach(() => {
    testState.executionHostId = 'local'
    testState.ownerKind = 'local'
    testState.targetIsRemoteRuntime = false
    testState.store.tabsByWorktree = { 'worktree-1': [{ id: 'terminal-tab-1' }] }
    latestInput = null
    bubbledDrop.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it('consumes a nested editor drop once and inserts top-level paths at the caret', async () => {
    render(<ComposerProbe initialDraft="$rev tail" />)
    // Tiptap mounts node-view portals from a microtask.
    await act(async () => {
      latestInput!.insertSkill!(0, 4, '$review')
    })
    expect(editor().querySelectorAll('[data-native-chat-skill]')).toHaveLength(1)

    const transfer = internalTransfer([
      '/repo/src',
      '/repo/src/index.ts',
      '/repo/My File.ts',
      '/repo/My File.ts'
    ])
    transfer.setData('text/plain', 'must not be inserted by ProseMirror')
    const accepted = dispatchDragEvent('drop', editor(), transfer)
    await act(async () => {})

    expect(accepted).toBe(false)
    expect(screen.getByTestId('draft').textContent).toBe(
      '$review @/repo/src @"/repo/My File.ts"  tail'
    )
    expect(editor().querySelectorAll('[data-native-chat-skill]')).toHaveLength(1)
    expect(
      [...editor().querySelectorAll('[data-native-chat-file-reference]')].map(
        (pill) => pill.textContent
      )
    ).toEqual(['src', 'My File.ts'])
    expect(editor().textContent).not.toContain('must not be inserted')
    expect(bubbledDrop).not.toHaveBeenCalled()
  })

  // Explorer paths from the same runtime host are readable by its agent.
  it('accepts a same-host drop on a remote runtime target and refuses a foreign one', () => {
    testState.executionHostId = 'runtime:env-1'
    testState.ownerKind = 'remote'
    testState.targetIsRemoteRuntime = true
    const view = render(<ComposerProbe structured={false} />)
    dispatchDragEvent(
      'drop',
      editor(),
      internalTransfer(['/env/owned.ts'], { executionHostId: 'runtime:env-1' })
    )
    expect(screen.getByTestId('draft').textContent).toBe('@/env/owned.ts ')
    view.unmount()

    render(<ComposerProbe structured={false} />)
    dispatchDragEvent(
      'drop',
      editor(),
      internalTransfer(['/elsewhere/foreign.ts'], { executionHostId: 'runtime:env-2' })
    )
    expect(screen.getByTestId('draft').textContent).toBe('')
    expect(screen.getByText('Files can only be attached to their source workspace.')).toBeTruthy()
  })

  it('queues an internal reference until composition settles without stealing focus', () => {
    render(<ComposerProbe initialDraft="preedit" />)
    const input = editor()
    act(() => latestInput!.setSelectionRange(7, 7))
    input.focus()
    fireEvent.compositionStart(input)
    dispatchDragEvent('drop', input, internalTransfer(['/repo/a.ts']))
    expect(screen.getByTestId('draft').textContent).toBe('preedit')

    fireEvent.compositionEnd(input, { data: '' })
    expect(screen.getByTestId('draft').textContent).toBe('preedit@/repo/a.ts ')
    expect(document.activeElement).toBe(input)
  })

  it('rejects an IME-queued path when its execution host changes before composition settles', () => {
    render(<ComposerProbe initialDraft="preedit" />)
    const input = editor()
    fireEvent.compositionStart(input)
    dispatchDragEvent('drop', input, internalTransfer(['/repo/a.ts']))

    testState.executionHostId = 'ssh:replacement'
    fireEvent.compositionEnd(input, { data: '' })

    expect(screen.getByTestId('draft').textContent).toBe('preedit')
    expect(screen.getByText('Files can only be attached to their source workspace.')).toBeTruthy()
  })

  // Recheck current workspace after IME; comparing only captured identities would miss a pane retarget.
  it('rejects an IME-queued path when the pane changes workspace before settling', () => {
    const view = render(<ComposerProbe initialDraft="preedit" />)
    const input = editor()
    fireEvent.compositionStart(input)
    dispatchDragEvent('drop', input, internalTransfer(['/repo/a.ts']))

    view.rerender(<ComposerProbe initialDraft="preedit" structuredWorkspaceId="worktree-2" />)
    fireEvent.compositionEnd(input, { data: '' })

    expect(screen.getByTestId('draft').textContent).toBe('preedit')
    expect(screen.getByText('Files can only be attached to their source workspace.')).toBeTruthy()
  })
})
