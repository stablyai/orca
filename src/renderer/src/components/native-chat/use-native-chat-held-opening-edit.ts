/** Editing a held chat opening whose files could not reach its host. The existing composer edit
 *  mode works on its own memory-only draft, never the chat's own draft, and Save replaces the
 *  opening under the same message and launch, which then finishes by itself. */

import { useCallback, useEffect, useReducer, useState } from 'react'
import {
  editableHostLaunchOpening,
  replaceHeldHostLaunchOpening
} from '@/lib/agent-session/launch/structured-agent-session-host-launch-opening-edit'
import { getStructuredLaunchStateBySessionId } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { readBrowserAttachmentFile } from '@/lib/browser-attachment-files'
import { queuedMessageWithEdit } from '../../../../shared/queued-message-edit'
import {
  structuredAgentSessionSendBody,
  type StructuredAgentSessionAttachment
} from '../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type { AgentJournalSkillRef } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { HeldHostLaunchOpeningEdit } from '@/lib/agent-session/launch/structured-agent-session-host-launch-opening-edit'
import {
  captureNativeChatEditDraftDestination,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
  subscribeToNativeChatComposerDraft,
  unavailableNativeChatComposerDraftImage,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { subscribeToNativeChatPendingAttachments } from './native-chat-pending-attachment-cache'
import {
  captureNativeChatStagedInput,
  nativeChatStagedInputPaths,
  stageNativeChatDraftFile
} from './native-chat-draft-attachment-staging'
import {
  createNativeChatQueuedEditDraft,
  discardNativeChatQueuedEdit,
  nativeChatQueuedEditHeld,
  nativeChatQueuedEditInput,
  type NativeChatQueuedEditDraft
} from './native-chat-queued-edit-draft'
import type {
  NativeChatComposerProps,
  NativeChatStructuredComposerTransport
} from './native-chat-composer-types'
import type { StructuredLaunchOpeningEdit } from './native-chat-structured-session-notices'

type OpeningEdit = {
  sessionId: string
  messageId: string
  draft: NativeChatQueuedEditDraft
  /** Client files the held opening still owed its host when the edit began. */
  owed: readonly string[]
  /** Owed sources are still being checked; Save waits so a missing one is never kept. */
  checking: boolean
}

type EditInput = { text: string; attachments: StructuredAgentSessionAttachment[] }

async function clientSourceAvailable(path: string): Promise<boolean> {
  if (readBrowserAttachmentFile(path)) {
    return true
  }
  const pathExists = typeof window === 'undefined' ? undefined : window.api?.fs?.pathExists
  try {
    return (await pathExists?.({ filePath: path })) === true
  } catch {
    return false
  }
}

/** Owed images whose source this client can no longer read come back asking to be attached again. */
async function markUnavailableOwedImages(scopeKey: string, owed: readonly string[]): Promise<void> {
  const owedPaths = new Set(owed)
  const checked = readNativeChatComposerDraft(scopeKey).images.filter(({ path }) =>
    owedPaths.has(path)
  )
  const available = await Promise.all(checked.map(({ path }) => clientSourceAvailable(path)))
  const missing = new Set(checked.filter((_, index) => !available[index]).map(({ path }) => path))
  if (missing.size === 0 || !captureNativeChatEditDraftDestination(scopeKey)?.active) {
    return
  }
  updateNativeChatComposerDraft(
    scopeKey,
    {
      images: readNativeChatComposerDraft(scopeKey).images.map((image) =>
        missing.has(image.path) ? unavailableNativeChatComposerDraftImage(image) : image
      )
    },
    'immediate'
  )
}

function openingEditInput(edit: OpeningEdit) {
  const typed = nativeChatQueuedEditInput(edit.draft, true, true)
  const valid =
    !edit.checking &&
    queuedMessageWithEdit(edit.draft.body, typed).ok &&
    !nativeChatQueuedEditHeld(edit.draft, true)
  const attachments = (typed.images ?? []).flatMap((block) =>
    block.path ? [{ path: block.path, previewUri: '' }] : []
  )
  return { valid, input: { text: typed.text, attachments }, skills: typed.skills }
}

/** As a creation stages its held message: client files go to a paired host under the launch. */
function stagedOpening(
  edit: OpeningEdit,
  input: EditInput,
  skills: readonly AgentJournalSkillRef[] | undefined
) {
  const scopeKey = edit.draft.scopeKey
  if (getStructuredLaunchStateBySessionId(edit.sessionId)?.intent.target.kind !== 'environment') {
    return undefined
  }
  // Kept files from the held opening join the edit's own attachments in one preparation.
  for (const path of edit.owed) {
    if (input.attachments.some((image) => image.path === path) || input.text.includes(path)) {
      stageNativeChatDraftFile(scopeKey, path)
    }
  }
  const paths = nativeChatStagedInputPaths(scopeKey, input)
  if (paths.length === 0) {
    return undefined
  }
  const lease = captureNativeChatStagedInput(scopeKey, input)
  const prepare: NonNullable<HeldHostLaunchOpeningEdit['staged']>['prepare'] = async (
    launchOperationId,
    target
  ) => {
    const prepared = await lease.prepare(
      { ...input, ...(skills ? { skills } : {}) },
      {
        sessionId: edit.sessionId,
        runtimeEnvironmentId: target.kind === 'environment' ? target.environmentId : null,
        launchOperationId
      }
    )
    return structuredAgentSessionSendBody(prepared.text, prepared.attachments, prepared.skills)
  }
  return { paths, prepare, release: () => lease.release() }
}

export type NativeChatHeldOpeningEditing = {
  draftScopeKey: string
  editSession: NonNullable<NativeChatComposerProps['editSession']>
}

/** `parked`: the launch shows as failed, which a held opening owing files to its host does; the
 *  caller's launch subscription renders this again whenever that changes. */
export function useNativeChatHeldOpeningEdit(
  worktreeId: string | null | undefined,
  sessionId: string,
  parked: boolean
): {
  /** For the launch notice: Edit while the opening can be edited, `editing` while it is. */
  notice: StructuredLaunchOpeningEdit | undefined
  editing: NativeChatHeldOpeningEditing | null
} {
  const editableId =
    parked && worktreeId
      ? (editableHostLaunchOpening(worktreeId, sessionId)?.opening.clientMessageId ?? null)
      : null
  const [edit, setEdit] = useState<OpeningEdit | null>(null)
  // A launch that was submitted, closed or ended takes no edit; the edit closes with nothing saved.
  if (edit && (edit.sessionId !== sessionId || edit.messageId !== editableId)) {
    setEdit(null)
  }
  const draft = edit?.draft
  const [, redraw] = useReducer((count: number) => count + 1, 0)
  // Only an open edit watches its draft; closing it discards that draft and nothing else.
  useEffect(() => {
    if (!draft) {
      return undefined
    }
    const unsubscribe = subscribeToNativeChatComposerDraft(draft.scopeKey, redraw)
    const unpending = subscribeToNativeChatPendingAttachments(draft.scopeKey, redraw)
    return () => {
      unsubscribe()
      unpending()
      discardNativeChatQueuedEdit(draft)
    }
  }, [draft])
  const canSave = edit !== null && openingEditInput(edit).valid

  const open = useCallback(() => {
    const editable = worktreeId ? editableHostLaunchOpening(worktreeId, sessionId) : undefined
    if (!editable) {
      return
    }
    const next: OpeningEdit = {
      sessionId,
      messageId: editable.opening.clientMessageId,
      draft: createNativeChatQueuedEditDraft(
        editable.opening.body,
        structuredAgentSessionDraftScopeKey(sessionId)
      ),
      owed: editable.staged,
      checking: true
    }
    setEdit(next)
    void markUnavailableOwedImages(next.draft.scopeKey, next.owed).finally(() =>
      setEdit((current) => (current === next ? { ...next, checking: false } : current))
    )
  }, [sessionId, worktreeId])

  const save = useCallback(() => {
    if (!edit || !worktreeId) {
      return
    }
    const { valid, input, skills } = openingEditInput(edit)
    if (!valid) {
      return
    }
    let body: HeldHostLaunchOpeningEdit['body']
    try {
      body = structuredAgentSessionSendBody(input.text, input.attachments, skills)
    } catch {
      return
    }
    const staged = stagedOpening(edit, input, skills)
    const replaced = replaceHeldHostLaunchOpening(worktreeId, sessionId, {
      body,
      ...(staged ? { staged: { paths: staged.paths, prepare: staged.prepare } } : {})
    })
    if (!replaced) {
      staged?.release()
    }
    setEdit(null)
  }, [edit, sessionId, worktreeId])
  const cancel = useCallback(() => setEdit(null), [])

  return {
    notice: edit ? 'editing' : editableId ? { open } : undefined,
    editing: edit
      ? { draftScopeKey: edit.draft.scopeKey, editSession: { save, cancel, canSave } }
      : null
  }
}

/** The chat's composer on its own draft, or switched to an open edit's draft and edit mode. */
export function nativeChatHeldOpeningComposerProps(
  { openingEdit: editing }: { openingEdit: NativeChatHeldOpeningEditing | null },
  paneKey: string,
  transport: NativeChatStructuredComposerTransport
): Pick<NativeChatComposerProps, 'paneKey' | 'draftScopeKey' | 'structuredTransport'> &
  Partial<NativeChatComposerProps> {
  return editing
    ? {
        paneKey: editing.draftScopeKey,
        draftScopeKey: editing.draftScopeKey,
        editSession: editing.editSession,
        steerHead: undefined,
        structuredTransport: {
          ...transport,
          // Files attached here stay with the edit until Save hands them to the launch.
          attachmentStagingScope: editing.draftScopeKey,
          sendOut: false,
          sendBlockedReason: undefined
        }
      }
    : {
        paneKey,
        draftScopeKey: structuredAgentSessionDraftScopeKey(transport.sessionId),
        structuredTransport: transport
      }
}
