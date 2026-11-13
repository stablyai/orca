import { useCallback, useMemo } from 'react'
import { prepareQueuedMessageEditText } from '../../../../../../shared/queued-message-edit-command'
import { useNativeChatComposerCatalog } from './use-native-chat-composer-catalog'
import {
  useNativeChatPickerState,
  type NativeChatPickerState
} from './use-native-chat-picker-state'
import {
  useNativeChatResumeCommand,
  type NativeChatResumeCommand
} from './use-native-chat-resume-command'
import type { NativeChatStructuredComposerTransport } from '../submit/native-chat-structured-composer-transport'
import { useNativeChatSideChatCommand } from './use-native-chat-side-chat-command'
import type { NativeChatPickerItem } from '../../../../../../shared/native-chat/input/native-chat-picker-items'
import { isNativeChatSideChatCommand } from '../../../../../../shared/native-chat/input/native-chat-side-chat-command'

type PickerArgs = Parameters<typeof useNativeChatPickerState>[0]
type ResumeArgs = Parameters<typeof useNativeChatResumeCommand>[0]

export function useNativeChatComposerCommandPicker(
  args: Omit<
    PickerArgs,
    | 'agentCommands'
    | 'sessionSkills'
    | 'onPickerOpened'
    | 'onPickerDemand'
    | 'skillsChecking'
    | 'launchWorktreeId'
    | keyof ResumeArgs['editor']
  > &
    Pick<ResumeArgs, 'editor' | 'setNotice'> & {
      structuredTransport: NativeChatStructuredComposerTransport | undefined
      /** An edit saves into a queued message; a launch prompt has no session to resume and
       *  lists its workspace's skills. */
      mode?: 'edit' | 'launch'
    }
): {
  picker: NativeChatPickerState
  orcaCommands: NativeChatResumeCommand
  /** Send opens a `/btw` or `/side` draft as a side chat, so the editor shows it as one. */
  sideChat: boolean
} {
  const { structuredTransport, editor, setNotice, mode, ...pickerArgs } = args
  const { agent, terminalTabId } = pickerArgs
  const { agentCommands, sessionSkills } = useNativeChatComposerCatalog(agent, structuredTransport)
  const reported = structuredTransport?.sessionCommands
  const hostSetsGoals = structuredTransport?.threadGoal !== undefined
  const hostSetsInteractionMode =
    structuredTransport?.optionSnapshot.some((entry) => entry.id === 'interactionMode') === true
  const acceptsText = useMemo(
    () => prepareQueuedMessageEditText(agent, reported, hostSetsGoals, hostSetsInteractionMode),
    [agent, reported, hostSetsGoals, hostSetsInteractionMode]
  )
  const commandAvailable = useCallback(
    (name: string) => mode === undefined || acceptsText(`/${name}`),
    [mode, acceptsText]
  )
  const listed = useNativeChatPickerState({
    ...pickerArgs,
    ...(mode === 'launch' ? { launchWorktreeId: structuredTransport?.worktreeId } : {}),
    ...editor,
    agentCommands,
    commandAvailable,
    sessionSkills,
    onPickerDemand: structuredTransport?.setCommandsMenuOpen,
    skillsChecking: structuredTransport?.commandsChecking === true,
    ...(!structuredTransport?.setCommandsMenuOpen && structuredTransport?.refreshCommands
      ? { onPickerOpened: structuredTransport.refreshCommands }
      : {})
  })
  const { completeItem: complete } = listed
  const { textareaRef } = editor
  // Tab, Enter or a click: a picked `/btw` reads as the pill, as a typed `/btw ` does.
  const completeItem = useCallback(
    (item: NativeChatPickerItem) => {
      complete(item)
      if (item.kind === 'command' && item.orcaOwned && isNativeChatSideChatCommand(item.name)) {
        textareaRef.current?.pillSideChatCommand?.()
      }
    },
    [complete, textareaRef]
  )
  const picker = { ...listed, completeItem }
  const resume = useNativeChatResumeCommand({
    structuredTransport,
    agent,
    terminalTabId,
    picker,
    editor,
    setNotice
  })
  const side = useNativeChatSideChatCommand({ structuredTransport, picker, editor })
  // `/btw` and `/resume` never collide, so each draft and pick has at most one owner.
  const { consume: sideConsume, matchesDraft: sideMatches, interceptPick: sideIntercept } = side
  const {
    consume: resumeConsume,
    matchesDraft: resumeMatches,
    interceptPick: resumeIntercept
  } = resume
  const orcaCommands = useMemo(
    (): NativeChatResumeCommand => ({
      matchesDraft: (draft) => sideMatches(draft) || resumeMatches(draft),
      consume: (draft) => sideConsume(draft) || resumeConsume(draft),
      interceptPick: (pick) => sideIntercept(resumeIntercept(pick))
    }),
    [resumeConsume, resumeIntercept, resumeMatches, sideConsume, sideIntercept, sideMatches]
  )
  return {
    picker,
    orcaCommands,
    sideChat: mode === undefined && structuredTransport?.sideChat !== undefined
  }
}
