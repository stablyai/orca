import { captureNativeChatEditDraftDestination } from './native-chat-composer-draft-store'
import { useNativeChatPickerCommandDispatch } from './use-native-chat-picker-command-dispatch'
import { useCallback, useLayoutEffect, useMemo, type RefObject } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { NativeChatPickerItem } from '../../../../shared/native-chat/input/native-chat-picker-items'
import { prepareQueuedMessageEditText } from '../../../../shared/queued-message-edit-command'
import { translate } from '@/i18n/i18n'
import { registerDictationComposerTarget } from '../dictation/dictation-insertion-target'
import { insertNativeChatComposerDraftText } from './native-chat-composer-draft-insertion'
import { registerNativeChatComposerDestination } from './native-chat-composer-destination'
import type {
  NativeChatComposerProps,
  NativeChatComposerHandle,
  NativeChatStructuredComposerTransport
} from './native-chat-composer-types'

export function useNativeChatComposerEditSession({
  editSession,
  root,
  handle,
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
  draftScopeKey: string
  agent: AgentType
  structuredTransport: NativeChatStructuredComposerTransport | undefined
  sendStructured: (text: string) => void
  ptyCommandRouting: Parameters<typeof useNativeChatPickerCommandDispatch>[0]
  setNotice: (text: string) => void
  disabled: boolean
  sendHeld: boolean
  sendMessage: () => void
  completeItem: (item: NativeChatPickerItem) => void
}) {
  const sessionCommands = structuredTransport?.sessionCommands
  const hostSetsGoals = structuredTransport?.threadGoal !== undefined
  const acceptsText = useMemo(
    () => prepareQueuedMessageEditText(agent, sessionCommands, hostSetsGoals),
    [agent, sessionCommands, hostSetsGoals]
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
    const destination = captureNativeChatEditDraftDestination(draftScopeKey)
    if (!element || !destination) {
      return
    }
    return registerDictationComposerTarget(element, (text) => {
      if (!destination.active) {
        return
      }
      insertNativeChatComposerDraftText(destination.scopeKey, text)
    })
  }, [draftScopeKey, root, handle])

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
  const send = useCallback(() => {
    if (!editSession) {
      sendMessage()
      return
    }
    if (!disabled && !sendHeld && editSession.canSave) {
      editSession.save()
    }
  }, [disabled, editSession, sendHeld, sendMessage])
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
