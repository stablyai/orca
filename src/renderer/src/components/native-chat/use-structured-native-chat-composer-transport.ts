// Wires a structured session into the composer's transport contract: sends, slash-command dispatch,
// the option surface and the runtime identity the composer needs to resolve attachments.

import { useMemo, type Dispatch, type SetStateAction } from 'react'
import { dispatchStructuredAgentSessionComposerCommand } from '../../../../shared/structured-agent-session-composer'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import type { useStructuredAgentSession } from './use-structured-agent-session'

export type StructuredNativeChatOptionPickerRequest = { id: string; sequence: number }

export function useStructuredNativeChatComposerTransport(args: {
  controller: ReturnType<typeof useStructuredAgentSession>
  agent: AgentType
  sessionId: string
  target: RuntimeClientTarget
  worktreeId: string | undefined
  optionPickerRequest: StructuredNativeChatOptionPickerRequest | null
  setOptionPickerRequest: Dispatch<SetStateAction<StructuredNativeChatOptionPickerRequest | null>>
  onError: (message: string | null) => void
}) {
  const {
    agent,
    controller,
    onError,
    optionPickerRequest,
    sessionId,
    setOptionPickerRequest,
    target,
    worktreeId
  } = args
  return useMemo(
    () => ({
      send: (text: string, attachments: readonly { id: string; path: string }[]): boolean =>
        controller.send(
          text,
          attachments.map((attachment) => ({
            path: attachment.path,
            previewUri: attachment.path
          }))
        ),
      dispatchCommand: (text: string) =>
        dispatchStructuredAgentSessionComposerCommand(text, {
          agent,
          snapshot: controller.optionSnapshot,
          invokeAction: async (id) => {
            setOptionPickerRequest((current) => ({ id, sequence: (current?.sequence ?? 0) + 1 }))
            return true
          },
          setOption: controller.setStructuredOption,
          conversationCommands: controller.conversationCommands,
          runConversationCommand: controller.runConversationCommand
        }),
      optionsSurface: controller.optionSurface,
      conversationCommands: controller.conversationCommands,
      optionSnapshot: controller.optionSnapshot,
      optionPickerRequest,
      sessionCommands: controller.sessionCommands,
      worktreeId,
      onError,
      runtime: (target.kind === 'local' ? 'local' : 'remote') as 'local' | 'remote',
      sessionId,
      runtimeEnvironmentId: target.kind === 'local' ? null : (target.environmentId ?? null)
    }),
    [
      agent,
      controller,
      onError,
      optionPickerRequest,
      sessionId,
      setOptionPickerRequest,
      target,
      worktreeId
    ]
  )
}
