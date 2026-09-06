import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { translate } from '@/i18n/i18n'
import type { AgentType } from '../../../../shared/agent-status-types'
import {
  emitNativeChatMessageSent,
  emitNativeChatPickerItemAccepted,
  emitNativeChatSendClassified
} from '@/lib/native-chat-telemetry'
import { sendNativeChatMessage, sendNativeChatTypedCommand } from './native-chat-runtime-send'
import {
  nativeChatComposerTargetIsRemote,
  type NativeChatResolvedTarget
} from './native-chat-composer-target'
import {
  pushHistory,
  type HistoryState,
  type NativeChatPickerItem
} from './native-chat-composer-state'
import type { NativeChatSendLifecycle } from './use-native-chat-send-lifecycle'
import type { NativeChatPtySessionOptionsSurface } from './native-chat-pty-session-options'
import type { NativeChatCommandMarkerOutcome } from './native-chat-command-marker'
import { runOmpLocalCommand, shouldRouteOmpLocalCommand } from './omp-rpc-local-command-route'

export function useNativeChatPickerCommandDispatch(args: {
  agent: AgentType
  /** Working directory keying the OMP RPC probe; null disables RPC routing. */
  ompRpcCwd?: string | null
  /** Sends a catalog command over the RPC session owning this pane; `false`
   *  means it declined and the PTY path below still applies. */
  sendOmpRpcCommand?: (text: string) => boolean
  disabled: boolean
  isDispatchingSessionOption: boolean
  resolveTarget: () => NativeChatResolvedTarget | null
  onSlashCommand?: (command: string, outcome?: NativeChatCommandMarkerOutcome) => void
  sessionOptionsSurface: NativeChatPtySessionOptionsSurface | null
  trackPendingSend: NativeChatSendLifecycle['trackPendingSend']
  setHistory: Dispatch<SetStateAction<HistoryState>>
  setDraft: (value: string) => void
  setCaret: Dispatch<SetStateAction<number>>
  setActiveSuggestion: Dispatch<SetStateAction<number>>
  clearSkillOrigin: () => void
  clearImageAttachments: () => void
  setNotice: Dispatch<SetStateAction<string | null>>
}): (command: Extract<NativeChatPickerItem, { kind: 'command' }>) => void {
  const {
    agent,
    ompRpcCwd = null,
    sendOmpRpcCommand,
    disabled,
    isDispatchingSessionOption,
    resolveTarget,
    onSlashCommand,
    sessionOptionsSurface,
    trackPendingSend,
    setHistory,
    setDraft,
    setCaret,
    setActiveSuggestion,
    clearSkillOrigin,
    clearImageAttachments,
    setNotice
  } = args
  return useCallback(
    (command) => {
      const text = `/${command.name}`
      if (disabled || isDispatchingSessionOption) {
        return
      }
      // Why: on an RPC-owned pane the PTY is gone by design, so a catalog
      // command has to go through the owning session. Asked first, and before
      // resolving a PTY target: only this call knows whether OMP's published
      // catalog proves the session runs the command, and when it does that
      // route beats the session-less probe below.
      if (sendOmpRpcCommand?.(text)) {
        emitNativeChatPickerItemAccepted({ agent, itemKind: 'command' })
        emitNativeChatSendClassified({ agent, outcome: 'command' })
        sessionOptionsSurface?.recordOutgoingCommand(text)
        setHistory((previous) => pushHistory(previous, text))
        setDraft('')
        setCaret(0)
        setActiveSuggestion(0)
        clearSkillOrigin()
        clearImageAttachments()
        setNotice(null)
        return
      }
      // Why: picking `/usage` from the menu must behave exactly like typing it
      // — same RPC route, same rendered output, same fallback. The probe needs
      // no live terminal (D1), so it also answers on a pane whose PTY is gone.
      if (shouldRouteOmpLocalCommand(agent, text)) {
        void runOmpLocalCommand(ompRpcCwd, text).then((outcome) => {
          if (outcome) {
            onSlashCommand?.(text, outcome)
            return
          }
          const fallbackTarget = resolveTarget()
          if (fallbackTarget) {
            trackPendingSend(
              sendNativeChatMessage(fallbackTarget.settings, fallbackTarget.ptyId, text)
            )
            onSlashCommand?.(text)
            return
          }
          // Neither the probe nor a PTY could run it; saying nothing would drop
          // the command silently now that the draft is already cleared.
          setNotice(
            translate(
              'components.native-chat.composer.ompRpcLocalCommandUnavailable',
              'This command could not be run: the agent connection did not answer and there is no live terminal.'
            )
          )
        })
        emitNativeChatPickerItemAccepted({ agent, itemKind: 'command' })
        emitNativeChatSendClassified({ agent, outcome: 'command' })
        setHistory((previous) => pushHistory(previous, text))
        setDraft('')
        setCaret(0)
        setActiveSuggestion(0)
        clearSkillOrigin()
        clearImageAttachments()
        setNotice(null)
        return
      }
      const target = resolveTarget()
      if (!target) {
        // Nothing claimed the command and there is no terminal left: a PTY-only
        // command on a pane whose RPC session also declined it.
        setNotice(
          translate(
            'components.native-chat.composer.commandRequiresPty',
            'This command needs a live terminal and cannot run over the agent connection.'
          )
        )
        return
      }
      trackPendingSend(
        agent === 'codex'
          ? sendNativeChatTypedCommand(target.settings, target.ptyId, text)
          : sendNativeChatMessage(target.settings, target.ptyId, text)
      )
      emitNativeChatPickerItemAccepted({ agent, itemKind: 'command' })
      // Why: picker dispatch is a catalog-verified command send; it must leave
      // the same telemetry and composer state as the typed path — including
      // disarming attachments, or a stale image rides the next prompt.
      emitNativeChatSendClassified({ agent, outcome: 'command' })
      onSlashCommand?.(text)
      sessionOptionsSurface?.recordOutgoingCommand(text)
      emitNativeChatMessageSent({
        agent,
        runtime: nativeChatComposerTargetIsRemote(target.ptyId) ? 'remote' : 'local'
      })
      setHistory((previous) => pushHistory(previous, text))
      setDraft('')
      setCaret(0)
      setActiveSuggestion(0)
      clearSkillOrigin()
      clearImageAttachments()
      setNotice(null)
    },
    [
      agent,
      clearImageAttachments,
      clearSkillOrigin,
      disabled,
      isDispatchingSessionOption,
      ompRpcCwd,
      onSlashCommand,
      resolveTarget,
      sendOmpRpcCommand,
      sessionOptionsSurface,
      setActiveSuggestion,
      setCaret,
      setDraft,
      setHistory,
      setNotice,
      trackPendingSend
    ]
  )
}
