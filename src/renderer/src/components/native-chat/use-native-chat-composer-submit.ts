import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { applyPickerSuggestion, type NativeChatPickerItem } from './native-chat-picker-items'
import { pushHistory, type HistoryState } from './native-chat-composer-state'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import {
  isBareStructuredAgentSessionGoalCommand,
  structuredAgentSessionGoalObjective
} from '../../../../shared/structured-agent-session-composer'

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

/**
 * What submitting the composer does: set the goal in goal mode, otherwise send
 * through the structured or PTY path. Goal mode exists only where the host can
 * set a goal, so it is inert everywhere else.
 */
export function useNativeChatComposerSubmit(args: {
  structuredTransport?: NativeChatStructuredComposerTransport
  draft: string
  caret: number
  imageAttachments: readonly NativeChatComposerImageAttachment[]
  disabled: boolean
  sendPty: () => void
  sendStructured: (text: string, attachments: readonly NativeChatComposerImageAttachment[]) => void
  setDraft: (value: string) => void
  setCaret: (caret: number) => void
  setHistory: (updater: (previous: HistoryState) => HistoryState) => void
}): { send: () => void; goalMode: NativeChatComposerGoalMode } {
  const { caret, disabled, draft, imageAttachments, sendPty, sendStructured } = args
  const { setCaret, setDraft, setHistory, structuredTransport } = args
  const threadGoal = structuredTransport?.threadGoal
  const [entered, setEntered] = useState(false)
  const active = entered && threadGoal !== undefined

  const interceptPick = useCallback(
    <TItem extends NativeChatPickerItem>(pick: (item: TItem) => void) =>
      (item: TItem) => {
        if (!threadGoal || item.kind !== 'command' || item.name !== GOAL_COMMAND) {
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
    [caret, draft, setCaret, setDraft, threadGoal]
  )

  // Setting a goal is a host round trip; the draft is cleared only if it is still
  // the one that was submitted, as with any other host command.
  const composition = useRef(draft)
  useLayoutEffect(() => {
    composition.current = draft
  }, [draft])

  // In-flight changes are serialized by the session's goal controller, which
  // answers false to a second submit while the first is unsettled.
  const setGoal = useCallback(() => {
    const objective = structuredAgentSessionGoalObjective(draft)
    if (!threadGoal || !structuredTransport || objective === '') {
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
    void threadGoal.setObjective(objective).then((accepted) => {
      if (!accepted) {
        return
      }
      structuredTransport.onError(null)
      setHistory((previous) => pushHistory(previous, draft))
      if (composition.current !== draft) {
        return
      }
      setDraft('')
      setCaret(0)
      setEntered(false)
    })
  }, [
    draft,
    imageAttachments.length,
    setCaret,
    setDraft,
    setHistory,
    structuredTransport,
    threadGoal
  ])

  const send = useCallback(() => {
    if (imageAttachments.some((attachment) => attachment.pending)) {
      return
    }
    if (threadGoal && structuredTransport && isBareStructuredAgentSessionGoalCommand(draft)) {
      // Same entrance as picking `/goal`: the token becomes the chip. Typed inside
      // goal mode it is still the entrance, never an objective.
      setDraft('')
      setCaret(0)
      setEntered(true)
    } else if (active) {
      if (!disabled) {
        setGoal()
      }
    } else if (!structuredTransport) {
      sendPty()
    } else if ((draft.trim() !== '' || imageAttachments.length > 0) && !disabled) {
      sendStructured(draft, imageAttachments)
    }
  }, [
    active,
    disabled,
    draft,
    imageAttachments,
    sendPty,
    sendStructured,
    setCaret,
    setDraft,
    setGoal,
    structuredTransport,
    threadGoal
  ])

  const exit = useCallback(() => setEntered(false), [])
  const goalMode = useMemo(() => ({ active, exit, interceptPick }), [active, exit, interceptPick])
  return { send, goalMode }
}
