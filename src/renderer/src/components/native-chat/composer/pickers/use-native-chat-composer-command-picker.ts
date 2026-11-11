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
import { useNativeChatClaudeInteractiveCommand } from './use-native-chat-claude-interactive-command'
import type { NativeChatComposerNotice } from '../controls/native-chat-composer-notice'
import { nativeChatComposerTargetIsRemote } from '../submit/native-chat-composer-target'
import { useTranslate } from '@/i18n/use-translate'
import { useNativeChatClaudeCommandPanel } from '../controls/use-native-chat-claude-command-panel'

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
      onSwitchToTerminal?: () => void
      targetPtyId: string | null
      readTerminalScreen?: () => string | null
      readTerminalDraft?: () => string | null
      isWorking?: boolean
    }
): {
  picker: NativeChatPickerState
  orcaCommands: NativeChatResumeCommand
  mcpNotice: NativeChatComposerNotice | null
  commandPanel: React.ReactNode
  disabled: boolean
} {
  const {
    structuredTransport,
    editor,
    setNotice,
    mode,
    onSwitchToTerminal,
    targetPtyId,
    readTerminalScreen,
    readTerminalDraft,
    isWorking,
    ...pickerArgs
  } = args
  const { agent, terminalTabId } = pickerArgs
  const panel = useNativeChatClaudeCommandPanel({
    structuredTransport,
    targetPtyId,
    readTerminalScreen,
    readTerminalDraft,
    onSwitchToTerminal,
    onReturnToDraft: () => editor.textareaRef.current?.focus(),
    disabled: pickerArgs.disabled,
    isWorking
  })
  const { inlineTerminal } = panel
  const translate = useTranslate()
  const { agentCommands, sessionSkills } = useNativeChatComposerCatalog(agent, structuredTransport)
  const commands = useMemo(() => {
    if (mode !== undefined || agent !== 'claude' || (!structuredTransport && !inlineTerminal)) {
      return agentCommands
    }
    const nativeCommands = [
      {
        name: 'mcp',
        description: translate(
          'components.native-chat.commands.mcp',
          'Manage MCP connections in Chat'
        ),
        orcaOwned: true as const
      },
      {
        name: 'config',
        description: translate('components.native-chat.commands.config', 'Open session settings'),
        orcaOwned: true as const
      },
      {
        name: 'permissions',
        description: translate(
          'components.native-chat.commands.permissions',
          'Open session permissions'
        ),
        orcaOwned: true as const
      },
      ...(!structuredTransport
        ? [
            {
              name: 'login',
              description: translate(
                'components.native-chat.commands.login',
                'Open Claude sign-in controls'
              ),
              orcaOwned: true as const
            }
          ]
        : [])
    ]
    return [
      ...nativeCommands,
      ...agentCommands.filter((entry) => !nativeCommands.some(({ name }) => name === entry.name))
    ]
  }, [agent, agentCommands, inlineTerminal, mode, structuredTransport, translate])
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
  const picker = useNativeChatPickerState({
    ...pickerArgs,
    disabled: panel.disabled,
    ...(mode === 'launch' ? { launchWorktreeId: structuredTransport?.worktreeId } : {}),
    ...editor,
    agentCommands: commands,
    commandAvailable,
    sessionSkills,
    onPickerDemand: structuredTransport?.setCommandsMenuOpen,
    skillsChecking: structuredTransport?.commandsChecking === true,
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
  const side = useNativeChatSideChatCommand({ structuredTransport, picker, editor })
  const mcp = useNativeChatClaudeInteractiveCommand({
    enabled: mode === undefined,
    inlineTerminal,
    agent,
    terminalTabId,
    draft: pickerArgs.draft,
    remote: structuredTransport
      ? structuredTransport.runtime === 'remote'
      : nativeChatComposerTargetIsRemote(targetPtyId),
    structuredTransport,
    onSwitchToTerminal,
    picker
  })
  const { consume: mcpConsume, matchesDraft: mcpMatches, interceptPick: mcpIntercept } = mcp
  const { consume: sideConsume, matchesDraft: sideMatches, interceptPick: sideIntercept } = side
  const {
    consume: resumeConsume,
    matchesDraft: resumeMatches,
    interceptPick: resumeIntercept
  } = resume
  const orcaCommands = useMemo(
    (): NativeChatResumeCommand => ({
      matchesDraft: (draft) => mcpMatches(draft) || sideMatches(draft) || resumeMatches(draft),
      consume: (draft) => mcpConsume(draft) || sideConsume(draft) || resumeConsume(draft),
      interceptPick: (pick) => mcpIntercept(sideIntercept(resumeIntercept(pick)))
    }),
    [
      mcpConsume,
      mcpIntercept,
      mcpMatches,
      resumeConsume,
      resumeIntercept,
      resumeMatches,
      sideConsume,
      sideIntercept,
      sideMatches
    ]
  )
  return {
    picker,
    orcaCommands,
    mcpNotice: !structuredTransport && !inlineTerminal ? mcp.notice : null,
    commandPanel: panel.panelFor(mcp.command, mcp.notice),
    disabled: panel.disabled
  }
}
