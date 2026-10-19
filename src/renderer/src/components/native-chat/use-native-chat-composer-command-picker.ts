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

/** The composer's `/` and `@` picker over its agent's catalog, with Orca's `/resume` taken first. */
export function useNativeChatComposerCommandPicker(
  args: Omit<PickerArgs, 'agentCommands' | 'sessionSkills' | keyof ResumeArgs['editor']> &
    Pick<ResumeArgs, 'editor' | 'setNotice'> & {
      structuredTransport: NativeChatStructuredComposerTransport | undefined
    }
): { picker: NativeChatPickerState; resume: NativeChatResumeCommand } {
  const { structuredTransport, editor, setNotice, ...pickerArgs } = args
  const { agent, terminalTabId } = pickerArgs
  const { agentCommands, sessionSkills } = useNativeChatComposerCatalog(agent, structuredTransport)
  const picker = useNativeChatPickerState({
    ...pickerArgs,
    ...editor,
    agentCommands,
    sessionSkills
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
