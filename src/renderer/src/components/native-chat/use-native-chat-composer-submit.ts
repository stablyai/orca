import { useCallback, useMemo, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { applyPickerSuggestion } from '../../../../shared/native-chat/input/native-chat-picker-triggers'
import type { NativeChatPickerItem } from '../../../../shared/native-chat/input/native-chat-picker-items'
import type {
  NativeChatComposerSendIntent,
  NativeChatStructuredComposerTransport
} from './native-chat-composer-types'
import type { NativeChatStructuredComposerSend } from './use-native-chat-structured-composer-send'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import { nativeChatImagesHoldSend } from './native-chat-image-reattach'
import {
  clearNativeChatComposerDraftIfUnchanged,
  readNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import {
  isBareStructuredAgentSessionGoalCommand,
  isStructuredAgentSessionHostCommand,
  structuredAgentSessionGoalObjective
} from '../../../../shared/agent-session/view/structured-agent-session-composer'

import {
  admitNativeChatPastedText,
  resolveNativeChatPastedText
} from './native-chat-composer-pasted-text-references'

const GOAL_COMMAND = 'goal'

export type NativeChatComposerGoalMode = {
  /** True while the draft is an objective rather than a message. */
  active: boolean
  exit: () => void
  /** Wraps a picker action so picking `/goal` enters goal mode instead. */
  interceptPick: <TItem extends NativeChatPickerItem>(
    pick: (item: TItem) => void
  ) => (item: TItem) => void
}

/** Reuse goal entry for host controls and native commands, preserving each submission path. */
export function useNativeChatComposerSubmit(args: {
  structuredTransport?: NativeChatStructuredComposerTransport
  draftScopeKey: string
  draft: string
  caret: number
  imageAttachments: readonly NativeChatComposerImageAttachment[]
  disabled: boolean
  sendPty: () => void
  sendStructured: NativeChatStructuredComposerSend
  /** Runs a command Orca owns, like `/resume`; true means the draft never reaches the agent. */
  consumeOrcaCommand?: (draft: string) => boolean
  matchesOrcaCommand?: (draft: string) => boolean
  setDraft: (value: string) => void
  setCaret: (caret: number) => void
}): {
  send: (intent?: NativeChatComposerSendIntent) => void
  goalMode: NativeChatComposerGoalMode
  messageDelivery: boolean
} {
  const { caret, disabled, draft, draftScopeKey, imageAttachments, sendPty, sendStructured } = args
  const { consumeOrcaCommand, setCaret, setDraft, structuredTransport } = args
  const threadGoal = structuredTransport?.threadGoal
  const [entered, setEntered] = useState(false)
  const active = entered && structuredTransport !== undefined

  const interceptPick = useCallback(
    <TItem extends NativeChatPickerItem>(pick: (item: TItem) => void) =>
      (item: TItem) => {
        // Without host goals only the provider's built-in /goal opens the chip; a namesake keeps its invocation.
        if (
          !structuredTransport ||
          item.kind !== 'command' ||
          item.name !== GOAL_COMMAND ||
          (!threadGoal && item.builtin !== true)
        ) {
          pick(item)
          return
        }
        // Drop the `/goal ` token the pick would have inserted; the chip replaces it.
        const inserted = applyPickerSuggestion(draft, caret, item)
        const tokenStart = inserted.caret - item.token.length - 1
        setDraft(inserted.draft.slice(0, tokenStart) + inserted.draft.slice(inserted.caret))
        setCaret(tokenStart)
        setEntered(true)
      },
    [caret, draft, setCaret, setDraft, structuredTransport, threadGoal]
  )

  // Native goals keep the ordinary sender's paste admission and clearing; host goals clear only an unchanged draft.
  const setGoal = useCallback(
    (intent?: NativeChatComposerSendIntent) => {
      const objective = structuredAgentSessionGoalObjective(
        threadGoal ? resolveNativeChatPastedText(draftScopeKey, draft) : draft
      )
      if (!structuredTransport || objective === '') {
        return
      }
      if (imageAttachments.length > 0) {
        structuredTransport.onError(
          translate(
            'components.native-chat.goal.attachmentsUnsupported',
            'Remove attachments before setting a goal.'
          )
        )
        return
      }
      if (!threadGoal) {
        const isCurrent = structuredTransport.capturePresentation()
        void sendStructured(`/goal ${objective}`, [], intent).then((accepted) => {
          if (accepted && isCurrent() && readNativeChatComposerDraft(draftScopeKey).text === '') {
            setEntered(false)
          }
        })
        return
      }
      structuredTransport.onSubmitted?.()
      const isCurrent = structuredTransport.capturePresentation()
      const submitted = readNativeChatComposerDraft(draftScopeKey)
      void threadGoal.setObjective(objective).then((accepted) => {
        if (!accepted) {
          return
        }
        if (!clearNativeChatComposerDraftIfUnchanged(draftScopeKey, submitted)) {
          return
        }
        if (isCurrent()) {
          structuredTransport.onError(null)
          setCaret(0)
          setEntered(false)
        }
      })
    },
    [
      draft,
      draftScopeKey,
      imageAttachments.length,
      sendStructured,
      setCaret,
      structuredTransport,
      threadGoal
    ]
  )

  const send = useCallback(
    (intent?: NativeChatComposerSendIntent) => {
      // Before goal mode too: a navigation command must never become an objective.
      if (consumeOrcaCommand?.(draft)) {
        return
      }
      if (
        structuredTransport &&
        !admitNativeChatPastedText(draftScopeKey, draft, structuredTransport.onError)
      ) {
        return
      }
      if (nativeChatImagesHoldSend(imageAttachments)) {
        return
      }
      if (threadGoal && structuredTransport && isBareStructuredAgentSessionGoalCommand(draft)) {
        // Bare /goal always enters goal mode; even there it must not become an objective.
        setDraft('')
        setCaret(0)
        setEntered(true)
      } else if (active) {
        if (!disabled) {
          setGoal(intent)
        }
      } else if (!structuredTransport) {
        sendPty()
      } else if ((draft.trim() !== '' || imageAttachments.length > 0) && !disabled) {
        if (intent) {
          sendStructured(draft, imageAttachments, intent)
        } else {
          sendStructured(draft, imageAttachments)
        }
      }
    },
    [
      active,
      consumeOrcaCommand,
      disabled,
      draft,
      draftScopeKey,
      imageAttachments,
      sendPty,
      sendStructured,
      setCaret,
      setDraft,
      setGoal,
      structuredTransport,
      threadGoal
    ]
  )

  const exit = useCallback(() => setEntered(false), [])
  const goalMode = useMemo(() => ({ active, exit, interceptPick }), [active, exit, interceptPick])
  const messageDelivery =
    !(active && threadGoal !== undefined) &&
    !args.matchesOrcaCommand?.(draft) &&
    !(
      structuredTransport &&
      isStructuredAgentSessionHostCommand(
        resolveNativeChatPastedText(draftScopeKey, draft),
        threadGoal !== undefined
      )
    )
  return { send, goalMode, messageDelivery }
}
