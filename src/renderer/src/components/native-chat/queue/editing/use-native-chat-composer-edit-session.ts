import { readNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-store'
import { nativeChatDraftHasEditingImage } from '../../media/notes/native-chat-chip-notes'
import type { NativeChatSendClassification } from '../../../../../../shared/native-chat/input/commands/native-chat-slash-commands'
import { captureNativeChatEditDraftDestination } from '../../drafts/native-chat-composer-draft-memory'
import { useNativeChatPickerCommandDispatch } from '../../composer/pickers/use-native-chat-picker-command-dispatch'
import {
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  type ForwardedRef,
  type RefObject
} from 'react'
import { useLatestHandler } from '@/lib/use-latest-handler'
import type { AgentType } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { NativeChatPickerItem } from '../../../../../../shared/native-chat/input/composer/native-chat-picker-items'
import { prepareQueuedMessageEditText } from '../../../../../../shared/native-chat/input/queued-messages/queued-message-edit-command'
import { translate } from '@/i18n/i18n'
import { registerDictationComposerTarget } from '../../../dictation/dictation-insertion-target'
import { useSendAfterDictation } from '../../../dictation/use-dictation-queued-send'
import { insertNativeChatComposerDraftText } from '../../drafts/native-chat-composer-draft-insertion'
import { registerNativeChatComposerDestination } from '../../composer/focus/native-chat-composer-destination'
import type { NativeChatComposerSendIntent } from '../../composer/submit/native-chat-composer-send-intent'
import type {
  NativeChatComposerProps,
  NativeChatComposerHandle
} from '../../composer/native-chat-composer-types'
import type { NativeChatStructuredComposerTransport } from '../../composer/submit/native-chat-structured-composer-transport'

export function useNativeChatComposerEditSession({
  editSession,
  root,
  handle,
  ref,
  draftScopeKey,
  agent,
  structuredTransport,
  sendStructured,
  ptyCommandRouting,
  setNotice,
  disabled,
  sendHeld,
  submission,
  peekSendClassification,
  completeItem
}: {
  editSession: NativeChatComposerProps['editSession']
  root: RefObject<HTMLDivElement | null>
  handle: RefObject<NativeChatComposerHandle | null>
  /** The composer's own ref: its handle plus `submit`, which sends as Enter does. */
  ref: ForwardedRef<NativeChatComposerHandle>
  draftScopeKey: string
  agent: AgentType
  structuredTransport: NativeChatStructuredComposerTransport | undefined
  sendStructured: (text: string) => void
  ptyCommandRouting: Parameters<typeof useNativeChatPickerCommandDispatch>[0]
  setNotice: (text: string) => void
  disabled: boolean
  sendHeld: boolean
  /** Enter's send, and whether Enter would deliver the draft to the agent as a message rather than run it as a command. */
  submission: {
    send: (intent?: NativeChatComposerSendIntent) => void
    messageDelivery: boolean
    /** A goal is being set: it takes no images, so no notes either. */
    goalActive?: boolean
  }
  peekSendClassification: (draft: string) => NativeChatSendClassification
  completeItem: (item: NativeChatPickerItem) => void
}) {
  const sessionCommands = structuredTransport?.sessionCommands
  const hostSetsGoals = structuredTransport?.threadGoal !== undefined
  const hostSetsInteractionMode =
    structuredTransport?.optionSnapshot.some((entry) => entry.id === 'interactionMode') === true
  const opensMcpPanel = structuredTransport?.mcpPanel !== undefined
  const acceptsText = useMemo(
    () =>
      prepareQueuedMessageEditText(
        agent,
        sessionCommands,
        hostSetsGoals,
        hostSetsInteractionMode,
        opensMcpPanel
      ),
    [agent, sessionCommands, hostSetsGoals, hostSetsInteractionMode, opensMcpPanel]
  )
  const isEditing = editSession !== undefined
  useLayoutEffect(() => {
    if (root.current && handle.current) {
      return registerNativeChatComposerDestination(root.current, handle, !isEditing, draftScopeKey)
    }
    return undefined
  }, [isEditing, root, handle, draftScopeKey])

  useLayoutEffect(() => {
    const element = root.current
    if (!element) {
      return
    }
    const destination = captureNativeChatEditDraftDestination(draftScopeKey)
    return registerDictationComposerTarget(element, (text) => {
      if (destination?.active === false) {
        return false
      }
      const focused = element.ownerDocument.activeElement
      insertNativeChatComposerDraftText(destination?.scopeKey ?? draftScopeKey, text, {
        // The mounted editor takes focus; don't pull it from a field the user moved to mid-dictation.
        draftOnly:
          !!focused && focused !== element.ownerDocument.body && !element.contains(focused),
        dictated: true
      })
      return true
    })
  }, [draftScopeKey, root])

  const refuseEditCommand = useCallback(
    (text: string): boolean => {
      if (!editSession || acceptsText(text)) {
        return false
      }
      setNotice(
        translate(
          'components.native-chat.queuedMessages.commandsUnsupported',
          "Commands can't be saved in a queued message."
        )
      )
      return true
    },
    [editSession, setNotice, acceptsText]
  )
  const sendOrQueue = useSendAfterDictation(root, submission.send)
  const send = useCallback(
    (intent?: NativeChatComposerSendIntent) => {
      if (!editSession) {
        // A marked image reopened in its viewer sits out Send until that viewer is done with it.
        if (nativeChatDraftHasEditingImage(draftScopeKey)) {
          setNotice(
            translate(
              'components.native-chat.notes.sendWhileEditing',
              'Close the image you’re editing notes on, then send.'
            )
          )
          return
        }
        sendOrQueue(intent)
        return
      }
      if (!disabled && !sendHeld && editSession.canSave) {
        editSession.save()
      }
    },
    [disabled, draftScopeKey, editSession, sendHeld, sendOrQueue, setNotice]
  )
  const submit = useLatestHandler(() => send())
  // Notes may send with the draft only when Enter would deliver it as a message, never run it as a command.
  const notesBlocked = useLatestHandler((): 'editing' | 'goal' | 'command' | null => {
    if (isEditing) {
      return 'editing'
    }
    if (submission.goalActive) {
      return 'goal'
    }
    const text = readNativeChatComposerDraft(draftScopeKey).text
    return submission.messageDelivery &&
      (Boolean(structuredTransport) || peekSendClassification(text) !== 'command')
      ? null
      : 'command'
  })
  // The pane's own handle object, so its identity changes only when that handle does.
  useImperativeHandle(ref, () => Object.assign(handle.current!, { submit, notesBlocked }))
  const chooseEditItem = useCallback(
    (item: Parameters<typeof completeItem>[0]) => {
      if (item.kind === 'command' && refuseEditCommand(`/${item.name}`)) {
        return
      }
      completeItem(item)
    },
    [completeItem, refuseEditCommand]
  )

  const dispatchPtyPickerCommand = useNativeChatPickerCommandDispatch(ptyCommandRouting)
  const dispatchPickerCommand = useCallback(
    (command: Parameters<typeof dispatchPtyPickerCommand>[0]) =>
      structuredTransport ? sendStructured(`/${command.name}`) : dispatchPtyPickerCommand(command),
    [structuredTransport, sendStructured, dispatchPtyPickerCommand]
  )
  const fieldOverrides = editSession
    ? {
        editSession,
        isWorking: false,
        goalMode: undefined,
        sessionOptionsSurface: null,
        contextUsage: null,
        sessionOptionsPickerRequest: null,
        onChoosePickerItem: chooseEditItem
      }
    : {}
  return { send, chooseEditItem, fieldOverrides, dispatchPickerCommand }
}
