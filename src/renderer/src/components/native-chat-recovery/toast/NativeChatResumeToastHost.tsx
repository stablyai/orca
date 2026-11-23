import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '../../../store/index'
import { activateAiVaultStructuredSession } from '@/lib/agent-session/open/activate-ai-vault-structured-session'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/native-chat/status/structured-agent-session-status-feed'
import { structuredChatShownName } from '@/runtime/native-chat/naming/structured-chat-shown-name'
import {
  localNativeChatRestartStore,
  useLocalRestartOffersEnabled,
  useNativeChatRestartOffer,
  useNativeChatRestartResuming
} from '../offers/native-chat-resume-on-restart-store'
import type { NativeChatRestartStore } from '../offers/native-chat-restart-runtime-store'
import type { NativeChatRestartOffer } from '../offers/native-chat-restart-host-offer'
import { useNativeChatRestartRuntimes } from '../offers/native-chat-restart-runtimes'
import type { ResumeFailureAction } from '../failures/native-chat-resume-failure-guidance'
import { resumeToastView } from './native-chat-resume-toast-view'
import { NativeChatResumeToast } from './NativeChatResumeToast'

export function NativeChatResumeToasts(): React.JSX.Element {
  const enabled = useLocalRestartOffersEnabled()
  const runtimes = useNativeChatRestartRuntimes()
  return (
    <>
      <NativeChatResumeToastHost store={localNativeChatRestartStore} offerEnabled={enabled} />
      {runtimes.map(({ environment, store }) => (
        <NativeChatResumeToastHost key={environment.id} store={store} offerEnabled />
      ))}
    </>
  )
}

/** Shows the store's report while it has an open request and something to say. */
function NativeChatResumeToastHost({
  store,
  offerEnabled
}: {
  store: NativeChatRestartStore
  offerEnabled: boolean
}): null {
  const { candidates, failed } = useNativeChatRestartOffer(offerEnabled, store)
  const waiting = useWaitingChats(candidates, failed, store)
  // Read one-shot open requests directly; a local mirror could go stale between launch and status-bar requests.
  const open = useSyncExternalStore(
    store.subscribeNativeChatResumeOnRestartDialog,
    store.getNativeChatResumeOnRestartDialogRequest,
    store.getNativeChatResumeOnRestartDialogRequest
  )
  const visible = offerEnabled && open && waiting.candidates.length + waiting.failed.length > 0
  const id = `native-chat-resume:${store.target.kind === 'local' ? 'local' : store.target.environmentId}`
  useEffect(() => {
    if (!visible) {
      return
    }
    // Only the person's own dismissal or the report's own timeout snoozes; this effect's cleanup must not consume a later request.
    let owned = true
    const snooze = (): void => {
      if (owned) {
        snoozeResumeToast(store)
      }
    }
    // Everything here needs the person, so it stays until closed.
    toast.custom(() => <ConnectedResumeToast store={store} toastId={id} />, {
      id,
      duration: Infinity,
      closeButton: false,
      unstyled: true,
      onDismiss: snooze,
      onAutoClose: snooze
    })
    return () => {
      owned = false
      toast.dismiss(id)
    }
  }, [visible, id, store])
  return null
}

/** A chat being resumed leaves the list at once: from then on it shows its own progress, and comes
 *  back here only if it couldn't be resumed. */
function useWaitingChats(
  candidates: NativeChatRestartOffer['candidates'],
  failed: NativeChatRestartOffer['failed'],
  store: NativeChatRestartStore
): Pick<NativeChatRestartOffer, 'candidates' | 'failed'> {
  const resuming = useNativeChatRestartResuming(store)
  return useMemo(() => {
    if (resuming.length === 0) {
      return { candidates, failed }
    }
    const taken = new Set(resuming)
    return {
      candidates: candidates.filter((row) => !taken.has(row.sessionId)),
      failed: failed.filter((row) => !taken.has(row.sessionId))
    }
  }, [candidates, failed, resuming])
}

/** Closing is a snooze: the host keeps the offer and the status bar keeps the way back to it. */
function snoozeResumeToast(store: NativeChatRestartStore): void {
  store.consumeNativeChatResumeOnRestartDialogRequest()
}

/** The toaster measures a toast only when it is issued; re-issuing in place keeps its state. */
function reissueResumeToast(store: NativeChatRestartStore, toastId: string): void {
  // Issuing a closed id would bring it back; a report that already left stays gone.
  if (!toast.getToasts().some((entry) => entry.id === toastId)) {
    return
  }
  toast.custom(() => <ConnectedResumeToast store={store} toastId={toastId} />, { id: toastId })
}

function ConnectedResumeToast({
  store,
  toastId
}: {
  store: NativeChatRestartStore
  toastId: string
}): React.JSX.Element {
  const offer = useNativeChatRestartOffer(true, store)
  const { candidates, failed } = useWaitingChats(offer.candidates, offer.failed, store)
  const view = useMemo(() => resumeToastView(candidates, failed), [candidates, failed])
  const { listedAt } = offer
  const remote = store.target.kind === 'environment'
  // Read here, so a server renamed while its report is open updates in place.
  const environmentId = store.target.kind === 'environment' ? store.target.environmentId : null
  const machineName = useAppStore((state) =>
    environmentId === null
      ? undefined
      : state.runtimeEnvironments.find((environment) => environment.id === environmentId)?.name
  )
  const close = useCallback(() => snoozeResumeToast(store), [store])
  const resume = (sessionIds: readonly string[]): void =>
    void store.continueNativeChatRestartOffer(sessionIds)

  // Details and row changes resize it; without a fresh measure it would grow off the screen.
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = root.current
    if (!node) {
      return
    }
    let height = node.getBoundingClientRect().height
    const observer = new ResizeObserver(() => {
      const next = node.getBoundingClientRect().height
      if (Math.abs(next - height) > 0.5) {
        height = next
        reissueResumeToast(store, toastId)
      }
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [store, toastId])
  const feed = getStructuredAgentSessionStatusFeed(store.target)
  const nameFor = (sessionId: string, fallback: string) =>
    structuredChatShownName(feed, sessionId)?.trim() || fallback

  const onRowAction = (action: ResumeFailureAction, sessionId: string): void => {
    if (action === 'dismiss') {
      void store.dismissNativeChatRestartOffer([sessionId])
      return
    }
    if (action === 'retry') {
      resume([sessionId])
      return
    }
    const row = view.rows.find((entry) => entry.candidate.sessionId === sessionId)
    if (!row) {
      return
    }
    // Opening is read-only; the person's own send settles the record.
    close()
    const session = {
      agent: row.candidate.agent,
      structuredSession: { workspaceId: row.candidate.workspaceId, sessionId }
    }
    void (remote
      ? activateAiVaultStructuredSession(session, undefined, store.target)
      : activateAiVaultStructuredSession(session))
  }

  // The wrapper always renders, so its size is observed from the first paint.
  return (
    <div
      ref={root}
      // Unstyled toasts aren't given the toaster's width; fill it rather than shrink to the text.
      className="w-[var(--width,100%)] max-w-full"
    >
      {view.rows.length > 0 && (
        <NativeChatResumeToast
          view={view}
          machineName={remote ? machineName : undefined}
          listedAt={listedAt}
          nameFor={nameFor}
          onResume={resume}
          onRowAction={onRowAction}
          onDismissAll={
            remote
              ? undefined
              : () => {
                  close()
                  void store.dismissNativeChatRestartOffer()
                }
          }
          onClose={close}
        />
      )}
    </div>
  )
}
