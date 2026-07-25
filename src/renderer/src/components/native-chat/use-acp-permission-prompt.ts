// Holds the ACP tool-approval prompt for one chat subscription and answers it.
//
// The agent's turn is blocked while a prompt is outstanding, so the two rules
// that matter are: (1) only show prompts belonging to this subscription, and
// (2) every prompt that is shown gets answered exactly once — a dismissal is an
// explicit cancel, never an implicit allow.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { NativeChatAcpPermissionPrompt } from '@/../../preload/api-types'
import type { ChatApproval } from './native-chat-interactive-prompt'

export type AcpPermissionPromptState = {
  /** The approval to render, or null when nothing is pending. */
  approval: ChatApproval | null
  /** Answer with an option's `send` value (the ACP optionId). */
  choose: (send: string) => void
  /** Dismiss without choosing — cancels the agent's request. */
  dismiss: () => void
}

/** Shape of the subset of `window.api.nativeChat` this hook needs, so tests can
 *  supply a stub without standing up the whole preload surface. */
export type AcpPermissionApi = {
  onAcpPermissionRequested: (
    listener: (prompt: NativeChatAcpPermissionPrompt) => void
  ) => () => void
  respondAcpPermission: (requestId: string, optionId: string | null) => Promise<boolean>
}

export function useAcpPermissionPrompt(
  subscriptionId: string | null,
  api: AcpPermissionApi | null | undefined
): AcpPermissionPromptState {
  const [prompt, setPrompt] = useState<NativeChatAcpPermissionPrompt | null>(null)
  // Why a ref alongside state: answer() must read the currently-pending prompt
  // without being re-created on every prompt change, so the callback identity
  // stays stable for the card's props.
  const pendingRef = useRef<NativeChatAcpPermissionPrompt | null>(null)
  const apiRef = useRef(api)
  apiRef.current = api

  useEffect(() => {
    if (api == null || subscriptionId == null) {
      return
    }
    const unsubscribe = api.onAcpPermissionRequested((incoming) => {
      // Prompts are broadcast to the renderer; take only this pane's.
      if (incoming.subscriptionId !== subscriptionId) {
        return
      }
      pendingRef.current = incoming
      setPrompt(incoming)
    })
    return () => {
      unsubscribe()
    }
  }, [api, subscriptionId])

  useEffect(() => {
    return () => {
      // Unmounting with a prompt open (tab closed, view toggled back to the
      // terminal) must not strand the agent waiting on an answer.
      const outstanding = pendingRef.current
      if (outstanding != null) {
        pendingRef.current = null
        void apiRef.current?.respondAcpPermission(outstanding.requestId, null)
      }
    }
  }, [])

  const answer = useCallback((optionId: string | null) => {
    const outstanding = pendingRef.current
    if (outstanding == null) {
      return
    }
    // Clear first so a double-click cannot answer the same request twice.
    pendingRef.current = null
    setPrompt(null)
    void apiRef.current?.respondAcpPermission(outstanding.requestId, optionId)
  }, [])

  const choose = useCallback((send: string) => answer(send), [answer])
  const dismiss = useCallback(() => answer(null), [answer])

  return {
    approval:
      prompt == null
        ? null
        : { title: prompt.title, detail: prompt.detail, options: prompt.options },
    choose,
    dismiss
  }
}
