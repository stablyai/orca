// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useLayoutEffect, useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  encodeWorkspaceFilePaths,
  WORKSPACE_FILE_PATHS_MIME,
  WORKSPACE_FILE_PATH_MIME,
  writeWorkspaceFileDragSource
} from '@/lib/workspace-file-drag'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type * as AttachmentUploadModule from './native-chat-attachment-upload'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { NativeChatComposerField } from './NativeChatComposerField'
import { useNativeChatComposerAttachments } from './use-native-chat-composer-attachments'
import { useNativeChatWorkspaceFileDrop } from './use-native-chat-workspace-file-drop'
import { useImeEnterGestureOwnership } from '@/lib/ime-composition-keyboard-event'

const testState: {
  executionHostId: ExecutionHostId
  ownerConnectionId: string
  ownerKind: 'local' | 'not-ready' | 'runtime' | 'ssh'
  ownerSshGeneration: number
  ownerWorktreePath: string
  targetIsRemoteRuntime: boolean
  store: { tabsByWorktree: Record<string, { id: string }[]> }
} = vi.hoisted(() => ({
  executionHostId: 'local',
  ownerConnectionId: 'ssh-1',
  ownerKind: 'local',
  ownerSshGeneration: 4,
  ownerWorktreePath: '/remote/repo',
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
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => testState.executionHostId
}))
// Real notice strings, so a copy of the wording here cannot outlive the string
// users actually read, and a newly added export cannot go missing from the mock.
vi.mock('./native-chat-attachment-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof AttachmentUploadModule>()),
  resolveNativeChatAttachmentOwnerForWorktree: () =>
    testState.ownerKind === 'ssh'
      ? {
          kind: 'ssh',
          connectionId: testState.ownerConnectionId,
          worktreePath: testState.ownerWorktreePath,
          expectedExecutionHostId: `ssh:${testState.ownerConnectionId}`,
          expectedSshTargetId: testState.ownerConnectionId,
          expectedSshConnectionGeneration: testState.ownerSshGeneration
        }
      : { kind: testState.ownerKind }
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  isRemoteRuntimePtyId: () => testState.targetIsRemoteRuntime
}))
vi.mock('./NativeChatComposerActions', () => ({
  NativeChatComposerActions: () => <div data-testid="composer-actions" />
}))
vi.mock('./NativeChatAutocompleteMenus', () => ({
  NativeChatMentionHint: () => null,
  NativeChatPickerMenu: () => null
}))
vi.mock('./NativeChatImageAttachmentPreview', () => ({
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
  // Not 'none' and not 'copy': the browser picks a default we did not choose, so
  // starting here is what makes an assertion on either verdict load-bearing.
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
    paneKey: `pane:${workspaceId}`,
    attachResolvedPaths: attachments.attachResolvedPaths,
    setNotice
  })
  useLayoutEffect(() => {
    latestInput = inputRef.current
  })

  return (
    <div onDrop={bubbledDrop}>
      {/* The pane around the composer mounts these in production; here they sit
          on a bare wrapper so the drop logic is exercised on its own. */}
      <div {...workspaceFileDropHandlers}>
        <NativeChatComposerField
          composerScopeKey={`pane:${workspaceId}`}
          textareaRef={inputRef}
          draft={draft}
          disabled={disabled}
          hasPty
          canSend={!disabled}
          autocomplete={{ mode: 'none' }}
          activeSuggestion={0}
          notice={notice}
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
          onAcceptMention={() => {}}
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
    testState.ownerConnectionId = 'ssh-1'
    testState.ownerKind = 'local'
    testState.ownerSshGeneration = 4
    testState.ownerWorktreePath = '/remote/repo'
    testState.targetIsRemoteRuntime = false
    testState.store.tabsByWorktree = { 'worktree-1': [{ id: 'terminal-tab-1' }] }
    latestInput = null
    bubbledDrop.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it('consumes a nested editor drop once and inserts top-level paths at the caret', () => {
    render(<ComposerProbe initialDraft="$rev tail" />)
    act(() => {
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

    expect(accepted).toBe(false)
    expect(screen.getByTestId('draft').textContent).toBe(
      '$review @/repo/src @"/repo/My File.ts"  tail'
    )
    expect(editor().querySelectorAll('[data-native-chat-skill]')).toHaveLength(1)
    expect(editor().textContent).not.toContain('must not be inserted')
    expect(bubbledDrop).not.toHaveBeenCalled()
  })

  it('advertises a copy drop while leaving unrelated drags alone', () => {
    render(<ComposerProbe />)
    const internal = internalTransfer(['/repo/a.ts'])
    const accepted = dispatchDragEvent('dragover', editor(), internal)
    expect(accepted).toBe(false)
    expect(internal.dropEffect).toBe('copy')

    const unrelated = new FileDragDataTransfer()
    unrelated.setData('text/plain', 'plain')
    unrelated.setData('text/html', '<b>plain</b>')
    dispatchDragEvent('dragover', editor(), unrelated)
    dispatchDragEvent('drop', editor(), unrelated)
    expect(bubbledDrop).toHaveBeenCalledOnce()
    expect(screen.getByTestId('draft').textContent).toBe('')
  })

  const mismatchedSources: [string, { executionHostId?: ExecutionHostId; workspaceId?: string }][] =
    [
      ['different workspace', { workspaceId: 'worktree-2' }],
      ['different execution host', { executionHostId: 'ssh:other' }]
    ]

  it.each(mismatchedSources)('rejects paths from a %s', (_label, source) => {
    render(<ComposerProbe />)
    dispatchDragEvent('drop', editor(), internalTransfer(['/repo/a.ts'], source))
    expect(screen.getByText('Files can only be attached to their source workspace.')).toBeTruthy()
    expect(screen.getByTestId('draft').textContent).toBe('')
  })

  it('rejects legacy unscoped payloads and unavailable owners', () => {
    const view = render(<ComposerProbe />)
    const unscoped = new FileDragDataTransfer()
    unscoped.setData(WORKSPACE_FILE_PATH_MIME, '/repo/a.ts')
    dispatchDragEvent('drop', editor(), unscoped)
    expect(screen.getByText('Files can only be attached to their source workspace.')).toBeTruthy()

    testState.ownerKind = 'not-ready'
    view.rerender(<ComposerProbe />)
    dispatchDragEvent('drop', editor(), internalTransfer(['/repo/b.ts']))
    expect(screen.getByText('Worktree not ready — try again in a moment.')).toBeTruthy()
    expect(screen.getByTestId('draft').textContent).toBe('')
  })

  // A guarded composer must refuse visibly. It still claims the event, because
  // the terminal surface behind it would otherwise paste the paths into the shell.
  it('refuses the drag outright while disabled instead of promising a copy', () => {
    render(<ComposerProbe disabled />)
    const hover = internalTransfer(['/repo/a.ts'])
    expect(dispatchDragEvent('dragover', editor(), hover)).toBe(false)
    expect(hover.dropEffect).toBe('none')
    expect(bubbledDrop).not.toHaveBeenCalled()

    const transfer = internalTransfer(['/repo/a.ts'])
    expect(dispatchDragEvent('drop', editor(), transfer)).toBe(false)
    expect(transfer.dropEffect).toBe('none')
    expect(screen.getByTestId('draft').textContent).toBe('')
  })

  // The relaxation that lets a runtime-owned path reach a runtime pane: the
  // explorer lists that host's filesystem, so the agent can read what it drags.
  it('accepts a same-host drop on a remote runtime target and refuses a foreign one', () => {
    testState.executionHostId = 'runtime:env-1'
    testState.ownerKind = 'runtime'
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

  it('rejects an IME-queued path when its SSH route changes under the same host', () => {
    testState.executionHostId = 'runtime:outer-env'
    testState.ownerKind = 'ssh'
    render(<ComposerProbe initialDraft="preedit" />)
    const input = editor()
    fireEvent.compositionStart(input)
    dispatchDragEvent(
      'drop',
      input,
      internalTransfer(['/remote/repo/a.ts'], { executionHostId: 'runtime:outer-env' })
    )

    testState.ownerConnectionId = 'ssh-2'
    fireEvent.compositionEnd(input, { data: '' })

    expect(screen.getByTestId('draft').textContent).toBe('preedit')
    expect(screen.getByText('Files can only be attached to their source workspace.')).toBeTruthy()
  })

  it('rejects an IME-queued path when the SSH connection reconnects under the same id', () => {
    testState.executionHostId = 'ssh:ssh-1'
    testState.ownerKind = 'ssh'
    render(<ComposerProbe initialDraft="preedit" />)
    const input = editor()
    fireEvent.compositionStart(input)
    dispatchDragEvent(
      'drop',
      input,
      internalTransfer(['/remote/repo/a.ts'], { executionHostId: 'ssh:ssh-1' })
    )

    testState.ownerSshGeneration = 5
    fireEvent.compositionEnd(input, { data: '' })

    expect(screen.getByTestId('draft').textContent).toBe('preedit')
    expect(screen.getByText('Files can only be attached to their source workspace.')).toBeTruthy()
  })

  // The queued check must ask which workspace this composer serves NOW. Comparing
  // a captured id against itself would pass no matter where the pane ended up.
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

  it('rejects only the exact unresolved-owner sentinel', () => {
    testState.executionHostId = 'runtime:unresolved-owner'
    const view = render(<ComposerProbe />)
    dispatchDragEvent(
      'drop',
      editor(),
      internalTransfer(['/repo/rejected.ts'], {
        executionHostId: 'runtime:unresolved-owner'
      })
    )
    expect(screen.getByTestId('draft').textContent).toBe('')

    testState.executionHostId = 'runtime:my-unresolved-owner-env'
    testState.ownerKind = 'runtime'
    view.rerender(<ComposerProbe />)
    dispatchDragEvent(
      'drop',
      editor(),
      internalTransfer(['/repo/accepted.ts'], {
        executionHostId: 'runtime:my-unresolved-owner-env'
      })
    )
    expect(screen.getByTestId('draft').textContent).toBe('@/repo/accepted.ts ')
  })

  it('attaches same-owner SSH images without uploading or client authorization', () => {
    testState.executionHostId = 'ssh:ssh-1'
    testState.ownerKind = 'ssh'
    render(<ComposerProbe />)
    dispatchDragEvent(
      'drop',
      editor(),
      internalTransfer(['/remote/repo/image.png'], {
        executionHostId: 'ssh:ssh-1'
      })
    )

    const image = screen.getByText('/remote/repo/image.png')
    expect(image.getAttribute('data-connection-id')).toBe('ssh-1')
    expect(screen.getByTestId('draft').textContent).toBe('')
  })

  it('supports PTY-owned and folder-workspace paths with the same ownership gate', () => {
    const first = render(<ComposerProbe structured={false} />)
    dispatchDragEvent('drop', editor(), internalTransfer(['/repo/pty.ts']))
    expect(screen.getByTestId('draft').textContent).toBe('@/repo/pty.ts ')
    first.unmount()

    render(<ComposerProbe workspaceId="folder:folder-1" />)
    dispatchDragEvent(
      'drop',
      editor(),
      internalTransfer(['/folder/note.md'], { workspaceId: 'folder:folder-1' })
    )
    expect(screen.getByTestId('draft').textContent).toBe('@/folder/note.md ')
  })
})
