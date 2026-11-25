import { useEffect, useState } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store/index'
import { NativeChatPromptSlotNotices } from '@/components/native-chat/composer/controls/NativeChatComposerNotices'
import {
  NativeChatHostSetupProvider,
  NativeChatTranscriptSignInNotice
} from '@/components/native-chat/host-access/NativeChatSignInRow'
import { NativeChatSetupButton } from '@/components/native-chat/host-access/NativeChatSetupButton'
import { nativeChatSignInContext } from '@/components/native-chat/host-access/native-chat-sign-in-account'
import { nativeChatSignInNoticeView } from '@/components/native-chat/host-access/native-chat-sign-in-notice'
import { createNativeChatSignInVisibility } from '@/components/native-chat/host-access/native-chat-sign-in-visibility'
import { useNativeChatSignIn } from '@/components/native-chat/host-access/use-native-chat-account-sign-in'
import { useNativeChatSignInVisibility } from '@/components/native-chat/host-access/use-native-chat-sign-in-visibility'
import { structuredSessionNotices } from '@/components/native-chat/messages/notices/native-chat-structured-session-notices'
import type { StructuredLaunchFailure } from '@/lib/agent-session/launch/structured-agent-session-launch-failure'
import { NativeChatQueuedMessageCard } from '@/components/native-chat/queue/NativeChatQueuedMessageCard'
import { agentSessionUnresolvedFailureRows } from '../../../src/shared/agent-session/failures/agent-session-visible-failures'
import { agentSessionFailureFact } from '../../../src/shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../src/shared/agent-session/failures/agent-session-failure-words'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session/journal/agent-session-journal-types'
import { AGENT_SESSION_MODEL_CATALOG_CONFIRM_SIGN_IN_RUNTIME_CAPABILITY } from '../../../src/shared/agent-session/capabilities/structured-agent-session-surface-capabilities'

const target = { kind: 'local' } as const
const rowId = 'fixture-auth-failure'
const managedFailure = agentSessionFailureFact('notSignedIn', { account: 'managed' })
const systemFailure = agentSessionFailureFact('notSignedIn', { account: 'system' })
const olderRow: AgentJournalRenderItem = {
  itemId: rowId,
  sequence: 1,
  revision: 1,
  observedAt: 1,
  body: {
    kind: 'status',
    tone: 'error',
    ...agentSessionFailureWords(managedFailure, { surface: 'row', agentName: 'Codex' })
  }
}
const latest = nativeChatSignInContext({
  unavailable: null,
  launchDetails: null,
  items: [olderRow],
  latestSubmission: {
    clientMessageId: 'fixture-later-send',
    dispatchState: 'rejected',
    rejection: { kind: 'cliMissing' },
    submittedSequence: 2,
    resolvedAt: 2
  }
})
const unresolved = new Set(agentSessionUnresolvedFailureRows([olderRow], { sentMessages: false }))
const params = new URLSearchParams(location.search)
const surface = params.get('surface')
const older = surface === 'older'
const queue = surface === 'queue' || surface === 'queue-clipped'
const launch = surface === 'launch'
const launchFailure: StructuredLaunchFailure = {
  kind: 'refused',
  code: 'agent_session_operation_invalid',
  details: { reason: 'notSignedIn', account: 'system' }
}
let launchRetries = 0
const retryLaunch = () => {
  launchRetries += 1
}
const lookups: PromiseWithResolvers<string | null>[] = []
const probes: PromiseWithResolvers<{
  ok: true
  result: { origin: 'unknown'; signInConfirmed?: true; freshProbe?: true }
}>[] = []
let openTerminals = 0
let shownTerminals = 0
let releaseReauthentication: (() => void) | undefined

Object.defineProperty(window, 'api', {
  configurable: true,
  value: {
    codexAccounts: {
      chatSignInAccount: () => {
        const pending = Promise.withResolvers<string | null>()
        lookups.push(pending)
        return pending.promise
      },
      reauthenticate: () =>
        new Promise<void>((resolve) => {
          releaseReauthentication = resolve
        })
    },
    runtime: {
      getStatus: async () => ({
        capabilities: [AGENT_SESSION_MODEL_CATALOG_CONFIRM_SIGN_IN_RUNTIME_CAPABILITY]
      }),
      call: () => {
        const pending = Promise.withResolvers<Awaited<(typeof probes)[number]['promise']>>()
        probes.push(pending)
        return pending.promise
      }
    }
  }
})
useAppStore.setState({ fetchSettings: async () => {} })

const terminal = {
  opening: false,
  async open() {
    const id = `fixture-login-${++openTerminals}`
    useAppStore.setState({
      ptyIdsByTabId: { [id]: ['fixture-login-pty'], unrelated: ['fixture-other-pty'] }
    })
    return { tabId: id }
  },
  show(tabId: string) {
    const open = Boolean(useAppStore.getState().ptyIdsByTabId[tabId]?.length)
    shownTerminals += Number(open)
    return open
  }
}

const observerCallbacks = new Map<IntersectionObserver, IntersectionObserverCallback>()
const NativeObserver = window.IntersectionObserver
window.IntersectionObserver = class extends NativeObserver {
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    super(callback, options)
    if (options?.threshold && Array.isArray(options.threshold) && options.threshold.includes(1)) {
      observerCallbacks.set(this, callback)
    }
  }

  override disconnect() {
    observerCallbacks.delete(this)
    super.disconnect()
  }
}

const controls = {
  pending: () => ({
    probes: probes.length,
    lookups: lookups.length,
    openTerminals,
    shownTerminals,
    launchRetries
  }),
  resolveLookup: (account: string | null) => lookups.shift()?.resolve(account),
  rejectLookup: () => lookups.shift()?.reject(new Error('Fixture discovery unavailable')),
  finishManaged: () => releaseReauthentication?.(),
  finishProbe: (result: 'confirmed' | 'legacy' | 'unknown') =>
    probes.shift()?.resolve({
      ok: true,
      result: {
        origin: 'unknown',
        ...(result === 'confirmed' ? { signInConfirmed: true } : {}),
        ...(result === 'legacy' ? { freshProbe: true } : {})
      }
    }),
  leaveTerminal: () => useAppStore.setState({ ptyIdsByTabId: {} }),
  leaveUnrelated: () =>
    useAppStore.setState((s) => ({
      ptyIdsByTabId: { ...s.ptyIdsByTabId, unrelated: [] }
    })),
  batch: () =>
    observerCallbacks.forEach((callback, observer) => {
      const bounds = new DOMRectReadOnly()
      const entry = (intersectionRatio: number): IntersectionObserverEntry => ({
        isIntersecting: intersectionRatio > 0,
        intersectionRatio,
        time: performance.now(),
        target: document.body,
        rootBounds: bounds,
        boundingClientRect: bounds,
        intersectionRect: bounds
      })
      callback([entry(1), entry(0)], observer)
    })
}
Object.defineProperty(window, 'signInFixture', { value: controls })

function Pane({ managed, failure, send }: { managed: boolean; failure: number; send: () => void }) {
  const [visibility] = useState(createNativeChatSignInVisibility)
  useEffect(() => () => visibility.dispose(), [visibility])
  const { signIn, resolved, announcement } = useNativeChatSignIn(
    {
      agent: 'codex',
      target,
      worktreeId: 'fixture-folder',
      sessionId: 'fixture-chat',
      needsSignIn: older ? latest.failure !== null : true,
      account: older ? latest.account : managed ? 'managed' : 'system',
      failureKey: older ? latest.failure?.key : `fixture-${failure}`,
      failure: null,
      startFailures: [],
      journalItems: older ? [olderRow] : [],
      onRechecked: () => {}
    },
    terminal
  )
  const setup = {
    signIn,
    resolved,
    announcement,
    visibility,
    install: null,
    unresolvedFailureRows: older ? unresolved : undefined,
    transcriptFailureId: older ? latest.failure?.rowId : queue ? undefined : rowId
  }
  const { banner } = useNativeChatSignInVisibility(setup)
  const bannerView = nativeChatSignInNoticeView({ kind: 'notSignedIn', agent: 'Codex', setup })
  const showBanner = banner && !older && bannerView !== null && !resolved
  // The launch notice comes from the production notice builder, Retry included.
  const launchNotices = launch
    ? structuredSessionNotices({
        launch: {
          lifecycle: 'failed',
          failure: launchFailure,
          retry: retryLaunch
        },
        agentLabel: 'Codex',
        sessionError: null,
        composerError: null,
        setup
      })
    : []
  return (
    <NativeChatHostSetupProvider value={{ ...setup, signInInComposer: showBanner }}>
      <div aria-label="Transcript" className="overflow-y-auto" style={{ height: 220 }}>
        {surface === 'queue-clipped' && <div style={{ height: 190 }} />}
        {launch ? null : queue ? (
          <ul>
            <NativeChatQueuedMessageCard
              card={{
                messageId: 'fixture-held',
                position: 1,
                text: 'Keep the original message.',
                state: 'returned',
                hold: 'returned',
                returnedRejection: systemFailure
              }}
              pending={null}
              chatWorktreeId={null}
              agentName="Codex"
              showsSteerShortcut={false}
              agentWorking={false}
              onSteer={send}
              onEdit={() => {}}
              onDelete={() => {}}
            />
          </ul>
        ) : (
          <section aria-label="Failure">
            <NativeChatTranscriptSignInNotice
              agentName="Codex"
              account={older || managed ? 'managed' : 'system'}
              rowId={rowId}
              fallback={() => <NativeChatSetupButton failureKind="notSignedIn" rowId={rowId} />}
              details={
                <details open>
                  <summary>Details</summary>
                  <div style={{ height: 420 }}>Fixture diagnostic</div>
                </details>
              }
            />
          </section>
        )}
        <div style={{ height: 480 }} />
      </div>
      <section aria-label="Composer notice">
        <NativeChatPromptSlotNotices
          notices={
            launch
              ? launchNotices
              : showBanner
                ? [
                    {
                      key: 'fixture-auth',
                      kind: 'error',
                      text: "Codex isn't signed in.",
                      signIn: bannerView
                    }
                  ]
                : []
          }
        />
      </section>
      <textarea aria-label="Draft" defaultValue="Keep the unrelated draft." />
    </NativeChatHostSetupProvider>
  )
}

export function SignInFixture() {
  const [managed, setManaged] = useState(surface === 'managed')
  const [failure, setFailure] = useState(1)
  const [mounted, setMounted] = useState(true)
  const [sent, setSent] = useState(0)
  return (
    <TooltipProvider>
      <main className="native-chat-appearance m-4" style={{ width: 360 }}>
        <button onClick={() => setManaged((value) => !value)}>Switch account</button>
        <button onClick={() => setFailure((value) => value + 1)}>Replace failure</button>
        <button onClick={() => setMounted((value) => !value)}>
          {mounted ? 'Unmount chat' : 'Remount chat'}
        </button>
        <output aria-label="Sent messages">{sent}</output>
        {mounted && (
          <Pane managed={managed} failure={failure} send={() => setSent((count) => count + 1)} />
        )}
      </main>
    </TooltipProvider>
  )
}
