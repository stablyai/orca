// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type * as AttachmentUploadModule from './native-chat-attachment-upload'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { NativeChatComposerField } from './NativeChatComposerField'
import { useNativeChatComposerAttachments } from './use-native-chat-composer-attachments'
import { useNativeChatComposerNotice } from './use-native-chat-composer-notice'
import { useNativeChatFileDrops } from './use-native-chat-file-drops'
import { NativeChatPaneFileDropSurface } from './NativeChatPaneFileDropSurface'
import { useNativeChatDraft } from './use-native-chat-draft'
import { clearNativeChatDraftCacheForTests } from './native-chat-draft-cache'
import { changePrompt, promptValue } from './native-chat-prompt-editor.test-support'
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
  resolveNativeChatAttachmentHost: () => testState.executionHostId,
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
  NativeChatMentionMenu: () => null,
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

type ProbeProps = {
  disabled?: boolean
  initialDraft?: string
  structured?: boolean
  /** Overrides only the structured target, leaving the pane's scope key alone. */
  structuredWorkspaceId?: string
  workspaceId?: string
}

const bubbledDrop = vi.fn()

function ComposerProbe({
  disabled = false,
  initialDraft = '',
  structured = true,
  structuredWorkspaceId,
  workspaceId = 'worktree-1'
}: ProbeProps): React.JSX.Element {
  const [caret, setCaret] = useState(initialDraft.length)
  const { notices, setNotice } = useNativeChatComposerNotice()
  const inputRef = useRef<NativeChatComposerInput>(null)
  const imeEnterGesture = useImeEnterGestureOwnership()
  const { draft, setDraft, flushDraftAppends } = useNativeChatDraft(
    `pane:${workspaceId}`,
    imeEnterGesture.isComposing
  )
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
  useNativeChatFileDrops({
    paneKey: `pane:${workspaceId}`,
    draftScopeKey: `pane:${workspaceId}`,
    targetPtyId: 'pty-1',
    terminalTabId: 'terminal-tab-1',
    structuredWorktreeId: structured ? (structuredWorkspaceId ?? workspaceId) : undefined,
    disabled,
    attachResolvedPaths: attachments.attachResolvedPaths,
    pendingChips: attachments.pendingChips,
    setNotice
  })

  return (
    <div onDrop={bubbledDrop}>
      <div>
        <NativeChatComposerField
          draftScopeKey={`pane:${workspaceId}`}
          textareaRef={inputRef}
          draft={draft}
          disabled={disabled}
          hasPty
          canSend={!disabled}
          autocomplete={{ mode: 'none' }}
          activeSuggestion={0}
          notices={notices}
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
            flushDraftAppends()
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

const prepare = vi.fn(async ({ paths }: { paths: string[] }) => ({ paths, failures: [] }))
beforeEach(() => {
  vi.clearAllMocks()
  clearNativeChatDraftCacheForTests()
  vi.stubGlobal('api', {
    fs: {
      getPathForFile: (file: File) => `/drop/${file.name}`,
      prepareDroppedPaths: prepare,
      stat: vi.fn(async () => ({ isDirectory: false }))
    }
  })
})
afterEach(() => {
  cleanup()
  clearNativeChatDraftCacheForTests()
  vi.unstubAllGlobals()
})

async function osDrop(target: HTMLElement) {
  const event = new Event('drop', { bubbles: true, cancelable: true, composed: true })
  Object.defineProperty(event, 'isTrusted', { value: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      types: ['Files'],
      files: [new File(['notes'], 'notes.txt')]
    }
  })
  await act(async () => target.dispatchEvent(event))
}

describe('OS file drops through the real composing chat field', () => {
  it.each(['commit', 'double commit', 'cancel', 'blur', 'blur then commit', 'restart'])(
    'settles one drop exactly once on %s and never replays it in a later composition',
    async (ending) => {
      render(
        <NativeChatPaneFileDropSurface className="chat">
          <ComposerProbe />
        </NativeChatPaneFileDropSurface>
      )
      const editor = screen.getByRole('textbox')
      fireEvent.compositionStart(editor)
      changePrompt(editor, 'ni')
      await osDrop(editor)
      expect(promptValue(editor)).toBe('ni')
      if (ending === 'cancel') {
        changePrompt(editor, '')
      }
      if (ending === 'blur' || ending === 'blur then commit') {
        fireEvent.blur(editor)
      }
      if (ending === 'restart') {
        fireEvent.compositionStart(editor)
      } else if (ending !== 'blur') {
        fireEvent.compositionEnd(editor, { data: ending === 'cancel' ? '' : 'ni' })
      }
      if (ending === 'double commit') {
        fireEvent.compositionEnd(editor, { data: 'ni' })
      }
      expect(promptValue(editor).match(/@\/drop\/notes.txt/g)).toHaveLength(1)
      expect(prepare).toHaveBeenCalledOnce()
      fireEvent.compositionStart(editor)
      fireEvent.compositionEnd(editor, { data: 'later' })
      expect(promptValue(editor).match(/@\/drop\/notes.txt/g)).toHaveLength(1)
    }
  )
})
