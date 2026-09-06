// The composer's `/usage` branch: run the command on the RPC probe and hand its
// output back as a command-marker outcome, falling back to the keystroke path
// whenever the probe cannot answer. Extracted from NativeChatComposer so the
// composer stays inside the max-lines ratchet.

import { useCallback, useEffect, useRef } from 'react'
import { translate } from '@/i18n/i18n'
import type { AgentType } from '../../../../shared/agent-status-types'
import { sendNativeChatMessage } from './native-chat-runtime-send'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'
import type { NativeChatCommandMarkerOutcome } from './native-chat-command-marker'
import { runOmpLocalCommand, shouldRouteOmpLocalCommand } from './omp-rpc-local-command-route'

/** Returns a dispatcher that reports whether it claimed the draft. `false`
 *  means the caller must run its normal send path unchanged. */
export function useOmpRpcLocalCommandSend(args: {
  agent: AgentType
  ompRpcCwd: string | null
  resolveTarget: () => NativeChatResolvedTarget | null
  onSlashCommand?: (command: string, outcome?: NativeChatCommandMarkerOutcome) => void
  /** Surfaces the dead end when neither the probe nor a PTY can run the
   *  command — on an acquired pane the PTY is gone, so without this the
   *  claimed draft would simply vanish. */
  setNotice?: (notice: string) => void
}): (text: string) => boolean {
  const { agent, ompRpcCwd, resolveTarget, onSlashCommand, setNotice } = args
  const generationRef = useRef(0)
  useEffect(() => {
    generationRef.current += 1
  }, [ompRpcCwd, resolveTarget])
  return useCallback(
    (text: string) => {
      if (!shouldRouteOmpLocalCommand(agent, text)) {
        return false
      }
      const command = text.trim()
      const generation = generationRef.current
      void runOmpLocalCommand(ompRpcCwd, command).then((outcome) => {
        if (generation !== generationRef.current) {
          return
        }
        if (outcome) {
          onSlashCommand?.(command, outcome)
          return
        }
        // Probe unavailable: fall back to the keystroke path so the command still
        // runs, just without rendered output.
        const target = resolveTarget()
        if (target) {
          sendNativeChatMessage(target.settings, target.ptyId, command)
          onSlashCommand?.(command)
          return
        }
        setNotice?.(
          translate(
            'components.native-chat.composer.ompRpcLocalCommandUnavailable',
            'This command could not be run: the agent connection did not answer and there is no live terminal.'
          )
        )
      })
      return true
    },
    [agent, ompRpcCwd, onSlashCommand, resolveTarget, setNotice]
  )
}
