import type { AgentType } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { serializeNativeChatAgentReferences } from '../pickers/native-chat-agent-reference-send'
import { mayHoldAgentReferences } from '../../../../../../shared/orchestration/mailbox/orchestration-agent-reference'
import { useCallback, useMemo, useState, type RefObject } from 'react'
import { translate } from '@/i18n/i18n'
import type { NativeChatPickerItem } from '../../../../../../shared/native-chat/input/composer/native-chat-picker-items'
import type { NativeChatComposerSendIntent } from './native-chat-composer-send-intent'
import type { NativeChatStructuredComposerTransport } from './native-chat-structured-composer-transport'
import type { NativeChatStructuredComposerSend } from './use-native-chat-structured-composer-send'
import type { NativeChatComposerImageAttachment } from '../../attachments/chips/native-chat-image-attachment'
import { nativeChatImagesHoldSend } from '../../attachments/chips/native-chat-image-reattach'
import {
  clearNativeChatComposerDraftIfUnchanged,
  readNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'
import {
  isBareStructuredAgentSessionGoalCommand,
  isStructuredAgentSessionHostCommand,
  structuredAgentSessionGoalObjective
} from '../../../../../../shared/agent-session/view/structured-agent-session-composer'
import {
  structuredAgentSessionModePickDraft,
  structuredAgentSessionPickEntersGoalMode
} from '../../../../../../shared/agent-session/view/structured-agent-session-goal-mode'
import { agentSessionInteractionCommand } from '../../../../../../shared/agent-session/options/permissions/agent-session-interaction-mode'
import { promptHasInteractionModeSkill } from '../editor/native-chat-prompt-document'
import { runSessionOptionSurfaceCall } from '../../session/options/controls/native-chat-session-option-surface-call'
import {
  writeNativeChatComposerText,
  type NativeChatComposerInput
} from '../editor/native-chat-composer-input'

import {
  admitNativeChatPastedText,
  resolveNativeChatPastedText
} from '../../paste/native-chat-composer-pasted-text-references'

export type NativeChatComposerGoalMode = {
  /** True while the draft is an objective rather than a message. */
  active: boolean
  exit: () => void
  /** Mode commands apply immediately instead of becoming draft text. */
  interceptPick: <TItem extends NativeChatPickerItem>(
    pick: (item: TItem) => void
  ) => (item: TItem) => void
}

/** Reuse goal entry for host controls and native commands, preserving each submission path. */
export function useNativeChatComposerSubmit(args: {
  structuredTransport?: NativeChatStructuredComposerTransport
  agent?: AgentType
  draftScopeKey: string
  draft: string
  caret: number
  textareaRef: RefObject<NativeChatComposerInput | null>
  imageAttachments: readonly NativeChatComposerImageAttachment[]
  disabled: boolean
  /** An optional-prompt action still passes the shared paste and attachment admission. */
  submitEmpty?: () => void
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
  const {
    agent,
    consumeOrcaCommand,
    setCaret,
    setDraft,
    structuredTransport,
    submitEmpty,
    textareaRef
  } = args
  const threadGoal = structuredTransport?.threadGoal
  const [entered, setEntered] = useState(false)
  const active = entered && structuredTransport !== undefined

  const interceptPick = useCallback(
    <TItem extends NativeChatPickerItem>(pick: (item: TItem) => void) =>
      (item: TItem) => {
        const mode =
          item.kind === 'command' && item.orcaOwned
            ? agentSessionInteractionCommand(agent ?? '', item.token)
            : null
        const modePick =
          mode !== null &&
          structuredTransport?.optionSnapshot.some((entry) => entry.id === 'interactionMode')
        if (
          !structuredTransport ||
          (!modePick && !structuredAgentSessionPickEntersGoalMode(item, threadGoal !== undefined))
        ) {
          pick(item)
          return
        }
        const input = textareaRef.current
        const next = structuredAgentSessionModePickDraft(
          input?.value ?? draft,
          input?.selectionStart ?? caret,
          item
        )
        if (!next) {
          return
        }
        if (modePick && mode !== null) {
          if (!structuredTransport.optionsSurface.admits?.('interactionMode', mode)) {
            input?.focus()
            return
          }
          runSessionOptionSurfaceCall(
            mode,
            () => undefined,
            () => structuredTransport.optionsSurface.setOption('interactionMode', mode)
          )
        }
        setDraft(next.draft)
        if (input) {
          writeNativeChatComposerText(input, next.draft, next.caret)
        }
        setCaret(next.caret)
        if (!modePick) {
          setEntered(true)
        }
      },
    [agent, caret, draft, setCaret, setDraft, structuredTransport, textareaRef, threadGoal]
  )

  // Native goals keep the ordinary sender's paste admission and clearing; host goals clear only an unchanged draft.
  const setGoal = useCallback(
    (intent?: NativeChatComposerSendIntent) => {
      const submitted = readNativeChatComposerDraft(draftScopeKey)
      // A host goal is one line; a provider /goal is sent as a message, so its notes keep their own lines.
      const objective = structuredAgentSessionGoalObjective(
        threadGoal || mayHoldAgentReferences(draft)
          ? serializeNativeChatAgentReferences(
              draft,
              submitted.document,
              submitted.pastedTextFiles,
              threadGoal ? 'goal' : 'message'
            )
          : draft
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
      } else if (!disabled && draft.trim() === '' && imageAttachments.length === 0) {
        submitEmpty?.()
      } else if (!disabled) {
        if (intent) {
          sendStructured(draft, imageAttachments, intent)
        } else {
          sendStructured(draft, imageAttachments)
        }
      }
    },
    [
      active,
      submitEmpty,
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
  const commandText = structuredTransport
    ? resolveNativeChatPastedText(draftScopeKey, draft)
    : draft
  const messageDelivery =
    !(active && threadGoal !== undefined) &&
    !args.matchesOrcaCommand?.(draft) &&
    !(
      structuredTransport &&
      !promptHasInteractionModeSkill(
        args.agent ?? '',
        commandText,
        readNativeChatComposerDraft(draftScopeKey).document
      ) &&
      isStructuredAgentSessionHostCommand(
        commandText,
        threadGoal !== undefined,
        args.agent,
        structuredTransport.optionSnapshot
      )
    )
  return { send, goalMode, messageDelivery }
}
