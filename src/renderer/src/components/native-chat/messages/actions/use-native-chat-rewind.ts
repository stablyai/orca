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

export type RewindInput = Omit<
  AgentSessionRewindInput,
  'capturePresentation' | 'returnToComposer' | 'send' | 'notify'
> & {
  capturePresentation: CaptureStructuredAgentSessionPresentation
  /** The composer the discarded message returns to, after whatever is typed there. */
  composerScopeKey?: string
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
  const rewind = useAgentSessionRewind(
    useMemo(() => {
      const scope = input.composerScopeKey
      return {
        ...input,
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
  const request = useCallback(
    (itemId: string, confirm: ConfirmationDialogContextValue) =>
      sharedRequest(itemId, () =>
        confirm({
          title: translate('components.native-chat.rewind.title', 'Rewind to here?'),
          description: translate(
            'components.native-chat.rewind.confirmation',
            'Discard this message and everything after it? The message returns to the composer so you can edit and resend it. File changes on disk are kept.'
          ),
          confirmLabel: translate('components.native-chat.rewind.confirm', 'Rewind'),
          cancelLabel: translate('components.native-chat.rewind.cancel', 'Cancel'),
          confirmVariant: 'destructive',
          cancelVariant: 'ghost'
        })
      ),
    [sharedRequest]
  )
  const shared = rewind.surface
  const surface = useMemo<NativeChatRewindSurface | undefined>(
    () => shared && { ...shared, request },
    [shared, request]
  )
  return { ...rewind, request, surface }
}
