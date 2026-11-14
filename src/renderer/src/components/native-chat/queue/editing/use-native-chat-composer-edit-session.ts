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
import type { NativeChatPickerItem } from '../../../../../../shared/native-chat/input/native-chat-picker-items'
import { prepareQueuedMessageEditText } from '../../../../../../shared/queued-message-edit-command'
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
  sendMessage,
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
  sendMessage: (intent?: NativeChatComposerSendIntent) => void
  completeItem: (item: NativeChatPickerItem) => void
}) {
  const sessionCommands = structuredTransport?.sessionCommands
  const conversationCommands = structuredTransport?.conversationCommands
  const cleanBackgroundTerminals = structuredTransport?.cleanBackgroundTerminals
  const hostSetsGoals = structuredTransport?.threadGoal !== undefined
  const hostSetsInteractionMode =
    structuredTransport?.optionSnapshot.some((entry) => entry.id === 'interactionMode') === true
  const acceptsText = useMemo(
    () =>
      prepareQueuedMessageEditText(
        agent,
        sessionCommands,
        hostSetsGoals,
        hostSetsInteractionMode,
        conversationCommands,
        cleanBackgroundTerminals
      ),
    [
      agent,
      sessionCommands,
      hostSetsGoals,
      hostSetsInteractionMode,
      conversationCommands,
      cleanBackgroundTerminals
    ]
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
  const sendOrQueue = useSendAfterDictation(root, sendMessage)
  const send = useCallback(
    (intent?: NativeChatComposerSendIntent) => {
      if (!editSession) {
        sendOrQueue(intent)
        return
      }
      if (!disabled && !sendHeld && editSession.canSave) {
        editSession.save()
      }
    },
    [disabled, editSession, sendHeld, sendOrQueue]
  )
  const submit = useLatestHandler(() => send())
  // The pane's own handle object, so its identity changes only when that handle does.
  useImperativeHandle(ref, () => Object.assign(handle.current!, { submit }))
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
