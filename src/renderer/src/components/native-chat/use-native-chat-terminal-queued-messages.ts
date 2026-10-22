import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { getDriverForPty } from '@/lib/pane-manager/mobile-driver-state'
import type { AgentType } from '../../../../shared/agent-status-types'
import {
  terminalQueuedDrafts,
  TERMINAL_QUEUED_DRAFT_CLAIM_MS,
  type TerminalQueuedDrafts
} from './native-chat-terminal-queued-drafts'
import { sendNativeChatMessage, type NativeChatSendHandle } from './native-chat-runtime-send'
import { sendNativeChatMessageWithImageAttachments } from './native-chat-runtime-image-send'
import type { StructuredAgentSessionQueuedMessagesController } from './use-structured-agent-session-queued-messages'
import { useNativeChatTerminalQueueController } from './use-native-chat-terminal-queue-controller'
import type { NativeChatOptimisticSendOutcome } from './native-chat-composer-types'
import { translate } from '@/i18n/i18n'

type Args = {
  scope: string
  onPresenceChange?: (present: boolean) => void
  ptyId: string | null
  agent: AgentType
  working: boolean
  completedTurn: string | null
  completedAt: number | null
  ready: boolean
  canSend: boolean
  promptOpen: boolean
  onSend: (text: string, images?: string[]) => string | undefined
  outcome: NativeChatOptimisticSendOutcome
}

export function useNativeChatTerminalQueuedMessages(args: Args): {
  controller: StructuredAgentSessionQueuedMessagesController
  enqueue: (text: string, imagePaths: string[]) => Promise<boolean> | null
  pause: () => void
} {
  const enabled = useAppStore((state) => state.settings?.nativeChatQueueFollowUps !== false)
  const [loaded, setLoaded] = useState<{ scope: string; queue: TerminalQueuedDrafts } | null>(null)
  const enqueueing = useRef(false)
  const stopEpoch = useRef(0)
  const storageFailed = useRef(false)
  const latest = useRef(args)
  const mounted = useRef(false)
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const inFlight = useRef<{ scope: string; handle: NativeChatSendHandle } | null>(null)
  useLayoutEffect(() => {
    latest.current = args
  })
  const queue = loaded?.scope === args.scope ? loaded.queue : null
  const onPresenceChange = args.onPresenceChange
  useEffect(() => {
    onPresenceChange?.((queue?.messages.length ?? 0) > 0)
  }, [onPresenceChange, queue?.messages.length])
  const reportError = () =>
    toast.error(
      translate(
        'components.native-chat.terminalQueue.storageError',
        'Could not save queued messages. Your draft was kept.'
      )
    )
  const publish = useCallback((scope: string, next: TerminalQueuedDrafts) => {
    if (mounted.current && latest.current.scope === scope) {
      setLoaded({ scope, queue: next })
    }
  }, [])
  useEffect(() => {
    const scope = args.scope
    storageFailed.current = false
    void (async () => terminalQueuedDrafts().read(scope))()
      .then((value) => publish(scope, value))
      .catch(() => {
        storageFailed.current = true
      })
  }, [args.scope, publish])
  useEffect(() => {
    const claims = queue?.messages.filter((message) => message.state === 'sending') ?? []
    if (claims.length === 0) {
      return
    }
    const scope = args.scope
    const deadline = Math.min(
      ...claims.map((message) => (message.claimedAt ?? 0) + TERMINAL_QUEUED_DRAFT_CLAIM_MS)
    )
    const timer = setTimeout(
      () => {
        void terminalQueuedDrafts()
          .recover(scope)
          .then((next) => publish(scope, next))
          .catch(reportError)
      },
      Math.max(0, deadline - Date.now())
    )
    return () => clearTimeout(timer)
  }, [args.scope, queue, publish])
  useLayoutEffect(
    () => () => {
      inFlight.current?.handle.cancel(true)
      inFlight.current = null
    },
    [args.scope, args.ptyId]
  )

  const change = useCallback(
    async (apply: (queue: TerminalQueuedDrafts) => void) => {
      const scope = latest.current.scope
      const next = await terminalQueuedDrafts().change(scope, apply)
      publish(scope, next)
    },
    [publish]
  )
  const writable = (current: Args): current is Args & { ptyId: string } =>
    current.ready &&
    current.canSend &&
    !current.promptOpen &&
    current.ptyId !== null &&
    getDriverForPty(current.ptyId)?.kind !== 'mobile'

  const dispatch = useCallback(
    async (messageId: string, explicit: boolean) => {
      const origin = latest.current
      const sendingEpoch = stopEpoch.current
      if (
        !mounted.current ||
        !writable(origin) ||
        inFlight.current ||
        (explicit && origin.working && origin.agent !== 'codex')
      ) {
        return
      }
      let dispatchHandle: NativeChatSendHandle | null = null
      try {
        const draft = await terminalQueuedDrafts().claim(origin.scope, messageId, explicit)
        if (!draft) {
          publish(origin.scope, await terminalQueuedDrafts().read(origin.scope))
          return
        }
        const claimedQueue = await terminalQueuedDrafts().read(origin.scope)
        const current = latest.current
        if (
          !mounted.current ||
          stopEpoch.current !== sendingEpoch ||
          current.scope !== origin.scope ||
          current.ptyId !== origin.ptyId ||
          !writable(current) ||
          (explicit && current.working && current.agent !== 'codex') ||
          (!explicit && current.working)
        ) {
          const next = await terminalQueuedDrafts().change(origin.scope, (queue) => {
            const message = queue.messages.find((message) => message.id === messageId)
            if (message?.state === 'sending' && message.claimId === draft.claimId) {
              message.state = 'waiting'
            }
          })
          publish(origin.scope, next)
          return
        }
        publish(origin.scope, claimedQueue)
        const pendingId = current.onSend(draft.text, draft.imagePaths)
        let accepted = false
        const options = {
          onWriteRejected: () => {
            if (pendingId) {
              current.outcome.reject(pendingId)
            }
          },
          onWriteUnconfirmed: () => {
            if (pendingId) {
              current.outcome.holdUnconfirmed(pendingId)
            }
          },
          onDeliverySettled: (value: boolean) => {
            accepted = value
          }
        }
        const handle = draft.imagePaths.length
          ? sendNativeChatMessageWithImageAttachments(
              current.agent,
              current.ptyId,
              draft.text,
              draft.imagePaths,
              options
            )
          : sendNativeChatMessage(current.ptyId, draft.text, options)
        dispatchHandle = handle
        inFlight.current = { scope: origin.scope, handle }
        await handle.settled
        const next = await terminalQueuedDrafts().settle(
          origin.scope,
          draft,
          accepted,
          current.completedTurn,
          current.completedAt
        )
        publish(origin.scope, next)
      } catch {
        reportError()
      } finally {
        if (dispatchHandle !== null && inFlight.current?.handle === dispatchHandle) {
          inFlight.current = null
        }
      }
    },
    [publish]
  )

  const controller = useNativeChatTerminalQueueController({
    scope: args.scope,
    queue,
    change,
    dispatch,
    canSteer: writable(args) && (!args.working || args.agent === 'codex'),
    supportsSteering: args.agent === 'codex',
    working: args.working,
    reportError
  })
  useEffect(() => {
    if (!queue || !args.ready || args.promptOpen) {
      return
    }
    if (queue.awaitingTurn) {
      if (
        !args.working &&
        args.completedTurn !== null &&
        args.completedTurn !== queue.afterTurn &&
        args.completedAt !== null &&
        (queue.afterTurnAt === null || args.completedAt > queue.afterTurnAt)
      ) {
        void change((next) => {
          if (next.afterTurn === queue.afterTurn && next.afterTurnAt === queue.afterTurnAt) {
            next.awaitingTurn = false
          }
        }).catch(reportError)
      }
      return
    }
    const first = queue.messages[0]
    if (
      first?.state === 'waiting' &&
      queue.messages.every((message) => message.state === 'waiting') &&
      !queue.paused &&
      !args.working &&
      controller.editor === undefined &&
      writable(args)
    ) {
      void dispatch(first.id, false)
    }
  }, [queue, args, controller.editor, change, dispatch])

  const enqueue = useCallback(
    (text: string, imagePaths: string[]): Promise<boolean> | null => {
      if (
        (!enabled || (!latest.current.working && !queue?.awaitingTurn)) &&
        (queue?.messages.length ?? 0) === 0
      ) {
        return null
      }
      if (!queue || !latest.current.ready) {
        if (storageFailed.current) {
          reportError()
        }
        return Promise.resolve(false)
      }
      if (enqueueing.current) {
        return Promise.resolve(false)
      }
      enqueueing.current = true
      return change((next) => {
        if (next.messages.length === 0 && latest.current.working) {
          next.awaitingTurn = true
          next.afterTurn = latest.current.completedTurn
          next.afterTurnAt = latest.current.completedAt
        }
        next.messages.push({ id: createBrowserUuid(), text, imagePaths, state: 'waiting' })
      })
        .then(
          () => true,
          () => {
            reportError()
            return false
          }
        )
        .finally(() => {
          enqueueing.current = false
        })
    },
    [queue, enabled, change]
  )

  return {
    controller,
    enqueue,
    pause: () => {
      stopEpoch.current += 1
      inFlight.current?.handle.cancel(true)
      void change((next) => {
        next.paused = next.messages.length > 0
      }).catch(reportError)
    }
  }
}
