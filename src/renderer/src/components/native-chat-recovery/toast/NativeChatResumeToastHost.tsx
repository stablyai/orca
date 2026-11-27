import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '../../../store/index'
import { activateAiVaultStructuredSession } from '@/lib/agent-session/open/activate-ai-vault-structured-session'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/native-chat/status/structured-agent-session-status-feed'
import { structuredChatShownName } from '@/runtime/native-chat/naming/structured-chat-shown-name'
import { NATIVE_CHAT_RESUME_SETTING_SECTION_ID } from '../../settings/chat/native-chat-resume-setting-target'
import {
  localNativeChatRestartStore,
  useLocalRestartOffersEnabled,
  useNativeChatRestartOffer,
  useNativeChatRestartRun
} from '../offers/native-chat-resume-on-restart-store'
import type { NativeChatRestartStore } from '../offers/native-chat-restart-runtime-store'
import { useNativeChatRestartRuntimes } from '../offers/native-chat-restart-runtimes'
import type { ResumeFailureAction } from '../failures/native-chat-resume-failure-guidance'
import { resumeRunFailures } from '../runs/native-chat-resume-run-view'
import { resumeToastShowsDetails, resumeToastView } from './native-chat-resume-toast-view'
import { NativeChatResumeToast } from './NativeChatResumeToast'
import { useResumeToastAutoDismiss } from './use-resume-toast-auto-dismiss'

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
  const run = useNativeChatRestartRun(store)
  // Read one-shot open requests directly; a local mirror could go stale between launch and status-bar requests.
  const open = useSyncExternalStore(
    store.subscribeNativeChatResumeOnRestartDialog,
    store.getNativeChatResumeOnRestartDialogRequest,
    store.getNativeChatResumeOnRestartDialogRequest
  )
  const visible =
    offerEnabled &&
    open &&
    ((run?.entries.length ?? 0) > 0 || candidates.length + failed.length > 0)
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
    // The report owns its timer so window visibility recovery can resume it.
    toast.custom(() => <ConnectedResumeToast store={store} toastId={id} />, {
      id,
      duration: Infinity,
      closeButton: false,
      unstyled: true,
      onDismiss: snooze
    })
    return () => {
      owned = false
      toast.dismiss(id)
    }
  }, [visible, id, store])
  return null
}

/** Closing is a snooze: the host keeps the offer and the status bar keeps the way back to it. */
function snoozeResumeToast(store: NativeChatRestartStore): void {
  store.consumeNativeChatResumeOnRestartDialogRequest()
  store.releaseFinishedNativeChatRestartRun()
}

/** The toaster measures a toast only when it is issued; re-issuing in place keeps its state. */
function reissueResumeToast(store: NativeChatRestartStore, toastId: string): void {
  // Issuing a closed id would bring it back; a report that already left stays gone.
  if (!toast.getToasts().some((entry) => entry.id === toastId)) {
    return
  }
  toast.custom(() => <ConnectedResumeToast store={store} toastId={toastId} />, {
    id: toastId
  })
}

function ConnectedResumeToast({
  store,
  toastId
}: {
  store: NativeChatRestartStore
  toastId: string
}): React.JSX.Element {
  const { candidates, failed, listedAt } = useNativeChatRestartOffer(true, store)
  const run = useNativeChatRestartRun(store)
  const failureBySession = useMemo(() => resumeRunFailures(run, failed), [run, failed])
  const view = useMemo(
    () => resumeToastView(run, candidates, failureBySession),
    [run, candidates, failureBySession]
  )
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const remote = store.target.kind === 'environment'
  // Read here, so a server renamed while its report is open updates in place.
  const environmentId = store.target.kind === 'environment' ? store.target.environmentId : null
  const machineName = useAppStore((state) =>
    environmentId === null
      ? undefined
      : state.runtimeEnvironments.find((environment) => environment.id === environmentId)?.name
  )
  const close = useCallback(() => snoozeResumeToast(store), [store])

  const finishedRun = view.phase === 'finished' ? run : null
  useEffect(() => {
    if (finishedRun) {
      store.markFinishedNativeChatRestartRunShown(finishedRun)
    }
  }, [finishedRun, store])

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
  const { onDetailsOpened } = useResumeToastAutoDismiss(
    view.phase === 'finished' && view.counts.needsYou === 0,
    close,
    root,
    resumeToastShowsDetails(view)
  )

  const feed = getStructuredAgentSessionStatusFeed(store.target)
  const nameFor = (sessionId: string, fallback: string) =>
    structuredChatShownName(feed, sessionId)?.trim() || fallback

  const onRowAction = (action: ResumeFailureAction, sessionId: string): void => {
    if (action === 'dismiss') {
      void store.dismissNativeChatRestartOffer([sessionId])
      return
    }
    if (action === 'retry') {
      void store.continueNativeChatRestartOffer([sessionId])
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
          onResume={(ids) => void store.continueNativeChatRestartOffer(ids)}
          onRowAction={onRowAction}
          onDetailsOpened={onDetailsOpened}
          onDismissAll={
            remote
              ? undefined
              : () => {
                  close()
                  void store.dismissNativeChatRestartOffer()
                }
          }
          onOpenSettings={() => {
            close()
            openSettingsPage()
            openSettingsTarget({
              pane: 'chat',
              repoId: null,
              sectionId: NATIVE_CHAT_RESUME_SETTING_SECTION_ID
            })
          }}
          onClose={close}
        />
      )}
    </div>
  )
}
