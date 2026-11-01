import { useCallback, useMemo } from 'react'
import { prepareQueuedMessageEditText } from '../../../../shared/queued-message-edit-command'
import { useNativeChatComposerCatalog } from './use-native-chat-composer-catalog'
import {
  useNativeChatPickerState,
  type NativeChatPickerState
} from './use-native-chat-picker-state'
import {
  useNativeChatResumeCommand,
  type NativeChatResumeCommand
} from './use-native-chat-resume-command'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

type PickerArgs = Parameters<typeof useNativeChatPickerState>[0]
type ResumeArgs = Parameters<typeof useNativeChatResumeCommand>[0]

export function useNativeChatComposerCommandPicker(
  args: Omit<
    PickerArgs,
    | 'agentCommands'
    | 'sessionSkills'
    | 'onPickerOpened'
    | 'onPickerDemand'
    | keyof ResumeArgs['editor']
  > &
    Pick<ResumeArgs, 'editor' | 'setNotice'> & {
      structuredTransport: NativeChatStructuredComposerTransport | undefined
      editing?: boolean
    }
): { picker: NativeChatPickerState; resume: NativeChatResumeCommand } {
  const { structuredTransport, editor, setNotice, editing, ...pickerArgs } = args
  const { agent, terminalTabId } = pickerArgs
  const { agentCommands, sessionSkills } = useNativeChatComposerCatalog(agent, structuredTransport)
  const reported = structuredTransport?.sessionCommands
  const hostSetsGoals = structuredTransport?.threadGoal !== undefined
  const acceptsText = useMemo(
    () => prepareQueuedMessageEditText(agent, reported, hostSetsGoals),
    [agent, reported, hostSetsGoals]
  )
  const commandAvailable = useCallback(
    (name: string) => !editing || acceptsText(`/${name}`),
    [editing, acceptsText]
  )
  const picker = useNativeChatPickerState({
    ...pickerArgs,
    ...editor,
    agentCommands,
    commandAvailable,
    sessionSkills,
    onPickerDemand: structuredTransport?.setCommandsMenuOpen,
    ...(!structuredTransport?.setCommandsMenuOpen && structuredTransport?.refreshCommands
      ? { onPickerOpened: structuredTransport.refreshCommands }
      : {})
  })
  const resume = useNativeChatResumeCommand({
    structuredTransport,
    agent,
    terminalTabId,
    picker,
    editor,
    setNotice
  })
  return { picker, resume }
}
