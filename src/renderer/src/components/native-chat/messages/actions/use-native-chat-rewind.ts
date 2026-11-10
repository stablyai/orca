import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import type { AgentSessionRewindResult } from '../../../../../../shared/agent-session/lifecycle/agent-session-rewind'
import {
  createAgentSessionRewindHook,
  type AgentSessionRewindInput
} from '../../../../../../shared/agent-session/lifecycle/agent-session-rewind-request'
import { sayNativeChatRewind } from './native-chat-rewind-copy'
import type {
  CaptureStructuredAgentSessionPresentation,
  StructuredAgentSessionWriteOutcome
} from '../../session/structured/writes/use-structured-agent-session-mutate'
import { returnMessageToComposer } from '../../session/structured/delivery/structured-agent-session-message-hand-back'
import type { NativeChatRewindSurface } from './use-native-chat-rewind-host'
import {
  nativeChatRewindPrompt,
  previewNativeChatRewindFiles,
  restoreNativeChatRewindFiles,
  type NativeChatCheckpointClient
} from './native-chat-rewind-files'

export type RewindInput = Omit<
  AgentSessionRewindInput,
  'capturePresentation' | 'returnToComposer' | 'send' | 'notify'
> & {
  capturePresentation: CaptureStructuredAgentSessionPresentation
  /** The composer the discarded message returns to, after whatever is typed there. */
  composerScopeKey?: string
  /** The host's per-turn file checkpoints; absent where the host can't restore files. */
  checkpoints?: NativeChatCheckpointClient
  send: (fields: {
    itemId: string
    expectedEpoch: string
  }) => Promise<StructuredAgentSessionWriteOutcome<AgentSessionRewindResult>>
}

const useAgentSessionRewind = createAgentSessionRewindHook(
  { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState },
  sayNativeChatRewind
)
const notify = { error: toast.error, message: toast.message }

export function useNativeChatRewind(input: RewindInput) {
  // The message whose files the user chose to restore, set on confirm and spent by its rewind.
  const restoreFilesFor = useRef<string | null>(null)
  const rewind = useAgentSessionRewind(
    useMemo(() => {
      const scope = input.composerScopeKey
      const { checkpoints } = input
      return {
        ...input,
        // Files follow the chat only once the chat itself went back; a refused rewind keeps both.
        send: async (fields: Parameters<RewindInput['send']>[0]) => {
          const outcome = await input.send(fields)
          const restore = restoreFilesFor.current === fields.itemId
          restoreFilesFor.current = null
          if (restore && checkpoints && outcome.kind === 'done') {
            // The host queues the next turn's snapshot behind this restore, so a send can't race it.
            void restoreNativeChatRewindFiles(checkpoints, fields.itemId)
          }
          return outcome
        },
        notify,
        ...(scope
          ? {
              returnToComposer: (
                itemId: string,
                blocks: Parameters<typeof returnMessageToComposer>[2]
              ) => {
                returnMessageToComposer(scope, `rewound-${itemId}`, blocks)
              }
            }
          : {})
      }
    }, [input])
  )
  const sharedRequest = rewind.request
  const checkpoints = input.checkpoints
  const request = useCallback(
    (itemId: string, confirm: ConfirmationDialogContextValue) =>
      sharedRequest(itemId, async () => {
        restoreFilesFor.current = null
        const preview = await previewNativeChatRewindFiles(checkpoints, itemId)
        return confirm({
          title: translate('components.native-chat.rewind.title', 'Rewind to here?'),
          ...nativeChatRewindPrompt(preview, (restoreFiles) => {
            restoreFilesFor.current = restoreFiles ? itemId : null
          }),
          confirmLabel: translate('components.native-chat.rewind.confirm', 'Rewind'),
          cancelLabel: translate('components.native-chat.rewind.cancel', 'Cancel'),
          confirmVariant: 'destructive',
          cancelVariant: 'ghost'
        })
      }),
    [checkpoints, sharedRequest]
  )
  const shared = rewind.surface
  const surface = useMemo<NativeChatRewindSurface | undefined>(
    () => shared && { ...shared, request },
    [shared, request]
  )
  return { ...rewind, request, surface }
}
