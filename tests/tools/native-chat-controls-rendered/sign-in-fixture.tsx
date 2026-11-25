import { useMemo, useState } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store/index'
import { NativeChatPromptSlotNotices } from '@/components/native-chat/composer/controls/NativeChatComposerNotices'
import {
  NativeChatHostSetupProvider,
  NativeChatTranscriptSignInNotice
} from '@/components/native-chat/host-access/NativeChatSignInRow'
import { NativeChatSetupButton } from '@/components/native-chat/host-access/NativeChatSetupButton'
import {
  useNativeChatStructuredPaneNotices,
  type NativeChatStructuredPaneNoticesInput
} from '@/components/native-chat/messages/notices/use-native-chat-structured-pane-notices'
import type { StructuredLaunchFailure } from '@/lib/agent-session/launch/structured-agent-session-launch-failure'
import { NativeChatQueuedMessageCard } from '@/components/native-chat/queue/NativeChatQueuedMessageCard'
import { agentSessionFailureFact } from '../../../src/shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../src/shared/agent-session/failures/agent-session-failure-words'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../src/shared/agent-session/journal/agent-session-journal-types'

// The chat pane's own notice wiring (banner ownership, filtering, the setup context) drives every
// surface here; only the host, the provider and the account lookup are simulated.
const WORKTREE = 'fixture-folder'
const params = new URLSearchParams(location.search)
const surface = params.get('surface')
const older = surface === 'older'
const queue = surface === 'queue' || surface === 'queue-clipped'
const launch = surface === 'launch'
const systemFailure = agentSessionFailureFact('notSignedIn', { account: 'system' })
const launchFailure: StructuredLaunchFailure = {
  kind: 'refused',
  code: 'agent_session_operation_invalid',
  details: { reason: 'notSignedIn', account: 'system' }
}
let launchRetries = 0
const retryLaunch = () => {
  launchRetries += 1
}
const demandModelCatalog = () => {}
const lookups: PromiseWithResolvers<string | null>[] = []
let reauthentication: { resolve: () => void; reject: (error: Error) => void } | null = null

function failureRow(id: string, sequence: number, account: 'managed' | 'system') {
  const fact = agentSessionFailureFact('notSignedIn', { account })
  const row: AgentJournalRenderItem = {
    itemId: id,
    sequence,
    revision: 1,
    observedAt: sequence,
    body: {
      kind: 'status',
      tone: 'error',
      ...agentSessionFailureWords(fact, { surface: 'row', agentName: 'Codex' })
    }
  }
  return row
}

function rejectedSend(
  id: string,
  sequence: number,
  rejection: AgentJournalSubmission['rejection']
) {
  const submission: AgentJournalSubmission = {
    clientMessageId: id,
    fence: 1,
    payloadFingerprint: id,
    dispatchState: 'rejected',
    providerItemId: null,
    reason: null,
    rejection,
    submittedAt: sequence,
    resolvedAt: sequence,
    submittedSequence: sequence
  }
  return submission
}

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
        new Promise<void>((resolve, reject) => {
          reauthentication = { resolve, reject }
        })
    }
  }
})
useAppStore.setState({ fetchSettings: async () => {} })

const loginTabs = () => (useAppStore.getState().tabsByWorktree[WORKTREE] ?? []).map((tab) => tab.id)

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
    lookups: lookups.length,
    openTerminals: loginTabs().length,
    reauthentications: reauthentication ? 1 : 0,
    launchRetries
  }),
  resolveLookup: (account: string | null) => lookups.shift()?.resolve(account),
  rejectLookup: () => lookups.shift()?.reject(new Error('Fixture discovery unavailable')),
  finishManaged: () => reauthentication?.resolve(),
  rejectManaged: () => reauthentication?.reject(new Error('Fixture provider rejected the account')),
  // The user closes the login terminal.
  leaveTerminal: () =>
    useAppStore.setState((s) => ({ tabsByWorktree: { ...s.tabsByWorktree, [WORKTREE]: [] } })),
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

function paneInput(
  failure: number,
  managed: boolean
): Omit<NativeChatStructuredPaneNoticesInput, 'controller'> & {
  journalItems: AgentJournalRenderItem[]
  submissions: AgentJournalSubmission[]
} {
  const journalItems = older
    ? [failureRow('fixture-auth-failure', 1, 'managed')]
    : queue || launch
      ? []
      : [failureRow(`fixture-auth-failure-${failure}`, failure, managed ? 'managed' : 'system')]
  const submissions = older
    ? [rejectedSend('fixture-later-send', 2, { kind: 'cliMissing' })]
    : queue
      ? [rejectedSend('fixture-held', failure, systemFailure)]
      : []
  return {
    journalItems,
    submissions,
    props: {
      agent: 'codex',
      target: { kind: 'local' },
      sessionId: 'fixture-chat',
      isVisible: true
    },
    ownerWorktreeId: WORKTREE,
    provisionalLaunch: launch
      ? { lifecycle: 'failed', failure: launchFailure }
      : { lifecycle: null, failure: null },
    submits: { retryLaunch },
    startFailures: [],
    continuation: {
      view: { wslDistro: null, remoteHost: false, hostLabel: null },
      continueError: null
    },
    deliveryNotices: undefined,
    agentLabel: 'Codex',
    viewState: { kind: 'ready' },
    readFailure: null,
    composerError: null,
    install: { slot: { kind: 'none' }, signIn: null, antigravityAuth: null },
    hostSendGate: { notice: null },
    hostNotice: null
  }
}

function Pane({ managed, failure, send }: { managed: boolean; failure: number; send: () => void }) {
  const { journalItems, submissions, ...input } = useMemo(
    () => paneInput(failure, managed),
    [failure, managed]
  )
  const { setup, notices } = useNativeChatStructuredPaneNotices({
    ...input,
    controller: {
      unavailable: null,
      submissions,
      journalItems,
      error: null,
      readRefusal: undefined,
      optionSurface: { demandModelCatalog }
    }
  })
  const [held, setHeld] = useState<'held' | 'editing' | 'deleted'>('held')
  const [draft, setDraft] = useState('Keep the unrelated draft.')
  const rowId = journalItems.at(-1)?.itemId
  return (
    <NativeChatHostSetupProvider value={setup}>
      <div aria-label="Transcript" className="overflow-y-auto" style={{ height: 220 }}>
        {surface === 'queue-clipped' && <div style={{ height: 190 }} />}
        {launch ? null : queue ? (
          held === 'deleted' ? null : (
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
                onEdit={() => setHeld('editing')}
                onDelete={() => setHeld('deleted')}
              />
            </ul>
          )
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
      <output aria-label="Held message">{held}</output>
      <section aria-label="Composer notice">
        <NativeChatPromptSlotNotices notices={notices} />
      </section>
      <textarea
        aria-label="Draft"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
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
