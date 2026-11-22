import { useNativeChatSessionOptionCommand } from '../../session/options/terminal/use-native-chat-session-option-command'
import { useNativeChatSessionOptions } from '../../session/options/terminal/use-native-chat-session-options'
import type { NativeChatComposerProps } from '../native-chat-composer-types'
import type { NativeChatSendHandle } from '../../session/terminal/send/native-chat-runtime-send'
import type { NativeChatPtySessionOptionsSurface } from '../../../../../../shared/native-chat/input/session-options/native-chat-pty-session-options'
import { nativeChatCommandOpensTerminal } from '../../../../../../shared/native-chat/input/commands/native-chat-agent-profiles'
import { useCallback, useMemo, useState } from 'react'
import type {
  SessionOptionDescriptor,
  SessionOptionSetResult,
  SessionOptionsSurface
} from '../../../../../../shared/native-chat/input/native-chat-session-options'
import { createNativeChatTurnNotedOptionPicksHook } from '../../../../../../shared/native-chat/input/session-options/use-native-chat-turn-noted-option-picks'

const useNativeChatTurnNotedOptionPicks = createNativeChatTurnNotedOptionPicksHook({
  useCallback,
  useMemo,
  useState
})

const isRefusedSetResult = (result: SessionOptionSetResult): boolean => result.refused === true

const NO_STRUCTURED_SNAPSHOT: SessionOptionDescriptor[] = []
const refuseStructuredOption = (): Promise<never> =>
  Promise.reject(new Error('No structured chat is attached.'))

type ComposerSessionOptionsArgs = Pick<
  NativeChatComposerProps,
  | 'agent'
  | 'terminalTabId'
  | 'targetPtyId'
  | 'paneKey'
  | 'onSlashCommand'
  | 'onSubmitted'
  | 'onSwitchToTerminal'
  | 'structuredTransport'
  | 'isWorking'
> &
  Pick<
    Parameters<typeof useNativeChatSessionOptionCommand>[0],
    'disabled' | 'resolveTarget' | 'readTerminalDraft'
  >

export function useNativeChatComposerSessionOptions({
  agent,
  disabled,
  onSlashCommand,
  onSubmitted,
  readTerminalDraft,
  resolveTarget,
  terminalTabId,
  targetPtyId,
  onSwitchToTerminal,
  paneKey,
  structuredTransport,
  isWorking = false
}: ComposerSessionOptionsArgs): {
  /** What a PTY command send needs from the session options. */
  ptyCommandRouting: {
    isDispatchingSessionOption: boolean
    sessionOptionsSurface: NativeChatPtySessionOptionsSurface | null
    /** Switches to Terminal once a command that opens a TUI screen is in. */
    onCommandSent: (command: string, delivery: NativeChatSendHandle) => void
  }
  surface: SessionOptionsSurface | null
  snapshot: SessionOptionDescriptor[]
} {
  const { dispatch, isDispatching } = useNativeChatSessionOptionCommand({
    agent,
    disabled,
    onSlashCommand,
    onSubmitted,
    readTerminalDraft,
    resolveTarget
  })
  const pty = useNativeChatSessionOptions({
    agent,
    terminalTabId,
    targetPtyId,
    dispatchCommand: dispatch,
    onAgentPicker: onSwitchToTerminal,
    paneKey,
    isWorking
  })
  const structuredSurface = structuredTransport?.optionsSurface ?? null
  const structured = useNativeChatTurnNotedOptionPicks({
    scope: structuredTransport?.sessionId ?? null,
    isWorking,
    snapshot: structuredTransport?.optionSnapshot ?? NO_STRUCTURED_SNAPSHOT,
    setOption: structuredSurface?.setOption ?? refuseStructuredOption,
    refused: isRefusedSetResult
  })
  const notingSurface = useMemo(
    () =>
      structuredSurface && {
        ...structuredSurface,
        getSnapshot: () => structured.snapshot,
        setOption: structured.setOption
      },
    [structuredSurface, structured.snapshot, structured.setOption]
  )
  const onCommandSent = useCallback(
    (command: string, delivery: NativeChatSendHandle) => {
      if (!onSwitchToTerminal || !nativeChatCommandOpensTerminal(agent, command)) {
        return
      }
      // Why: leaving the chat cancels its pending writes, so switch only once the command is in.
      void delivery.outcome?.then((outcome) => {
        if (outcome === 'submitted') {
          onSwitchToTerminal()
        }
      })
    },
    [agent, onSwitchToTerminal]
  )
  return {
    ptyCommandRouting: {
      isDispatchingSessionOption: isDispatching,
      sessionOptionsSurface: pty.surface,
      onCommandSent
    },
    surface: notingSurface ?? pty.surface,
    snapshot: structuredTransport ? structured.snapshot : pty.snapshot
  }
}
