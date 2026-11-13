import { onPRDetailRecoveryAuthorityLost } from './pr-detail-recovery-authority'
import type { StateCreator } from 'zustand'
import { createNonSecureContextUuid } from '../../../../../shared/non-secure-context-uuid'
import type { AppState } from '../../types'
import type { PRDetailRecoverySnapshot } from '../../../../../shared/github/pull-requests/refresh/pr-detail-recovery-contract'
import {
  inflightPRRequests,
  onPRLookupIntent,
  pinPRLookupIntent,
  prLookupIntentRevision
} from '../requests/request-coordination'
import {
  hasUsableGitHubPR,
  prDetailRecoveryContextKey,
  prDetailRecoveryContextLive,
  resolvePRDetailRecoveryOwner,
  type PRDetailRecoveryContext,
  type PRDetailRecoveryStatus,
  type PRDetailRecoveryUiState
} from './pr-detail-recovery-context'
import {
  capturePRDetailRecoveryGrant,
  prDetailRecoveryGrantOwnsAlias,
  publishPRDetailRecoveryOutcome,
  releasePRDetailRecoveryGrant
} from './pr-detail-recovery-publication'
import { resolvePRDetailRecoveryTransport } from './pr-detail-recovery-transport'
import {
  awaitWithBudget,
  detachPRDetailRecoverySubscription as detach,
  newPRDetailRecoverySubscription,
  recoveryRuntimeTarget,
  retainedEpochs,
  startWithResume,
  buildPRDetailRecoveryIdentity,
  terminalRecoveryStatus,
  type PRDetailRecoverySubscription as Subscription
} from './pr-detail-recovery-subscription'

type SetState = Parameters<StateCreator<AppState>>[0]
type GetState = Parameters<StateCreator<AppState>>[1]

export type PRDetailRecoverySlice = {
  prDetailRecovery: PRDetailRecoveryUiState | null
  /** A hidden-to-visible Checks panel transition: the only event that re-arms automatic recovery. */
  notePRDetailRecoveryPanelVisible: (visible: boolean) => void
  reconcileGitHubPRDetails: (context: PRDetailRecoveryContext | null) => void
  /** Manual Retry owns the next read; detach this panel's automatic ticket first. */
  cancelGitHubPRDetailRecovery: () => void
  /** A settled Retry that left no usable PR reports its own outcome, announced once. */
  settleGitHubPRDetailRetry: (
    contextKey: string,
    status: PRDetailRecoveryStatus,
    announce?: boolean
  ) => void
}

// Random renderer scope plus counter identifies retries within the retained ticket window.
const EPOCH_SCOPE = `g${Date.now()}.${createNonSecureContextUuid()}`
let epochCounter = 0
let panelVisible = false
let current: Subscription | null = null

// A newer local direct lookup is new intent even before its host registration arrives.
onPRLookupIntent((cacheKey) => {
  const sub = current
  if (sub && !sub.cancelled && sub.owner.cacheKey === cacheKey && !sub.admitted) {
    sub.yieldToNewerIntent()
  }
})

export const createPRDetailRecoveryActions = (
  set: SetState,
  get: GetState
): PRDetailRecoverySlice => {
  const record = (contextKey: string, status: PRDetailRecoveryStatus, bump: number): void => {
    retainedEpochs.set(contextKey, status)
    set((s) => ({
      prDetailRecovery: {
        contextKey,
        status,
        terminalCount: (s.prDetailRecovery?.terminalCount ?? 0) + bump
      }
    }))
  }

  const live = (sub: Subscription): boolean =>
    current === sub &&
    !sub.cancelled &&
    !sub.transport?.signal?.aborted &&
    prDetailRecoveryContextLive(get(), sub.context, sub.owner)

  const show = (sub: Subscription, status: PRDetailRecoveryStatus, terminal = false): void => {
    if (current !== sub) {
      return
    }
    if (terminal) {
      sub.transport?.dispose?.()
      sub.releaseIntentPin()
      record(sub.contextKey, status, 1)
      return
    }
    set((s) => ({
      prDetailRecovery: {
        contextKey: sub.contextKey,
        status,
        terminalCount: s.prDetailRecovery?.terminalCount ?? 0
      }
    }))
  }

  const prepare = async (sub: Subscription, snapshot: PRDetailRecoverySnapshot): Promise<void> => {
    const preparation = snapshot.preparation
    if (!preparation || !sub.transport) {
      return
    }
    if (!sub.grant || sub.grant.prepareToken !== preparation.token) {
      // One synchronous guarded transaction; duplicate notices reuse the grant.
      if (!live(sub) || prLookupIntentRevision(sub.owner.cacheKey) !== sub.intentRevision) {
        // Newer intent or a changed context owns the alias now; close without a grant.
        detach(sub)
        show(sub, { kind: 'closed' }, true)
        return
      }
      releasePRDetailRecoveryGrant(sub.owner, sub.grant)
      const runtime = recoveryRuntimeTarget(get(), sub)
      sub.grant = capturePRDetailRecoveryGrant(
        get,
        sub.context,
        sub.owner,
        runtime?.target.environmentId ?? null,
        preparation.token
      )
    }
    const args = {
      ticketId: snapshot.ticketId,
      prepareToken: preparation.token,
      publicationGrantId: sub.grant.grantId
    }
    // Commit is idempotent: a lost acknowledgment replays the same token and grant.
    await sub.transport.commit(args).catch(() => sub.transport?.commit(args).catch(() => null))
  }

  const settle = (sub: Subscription, snapshot: PRDetailRecoverySnapshot): void => {
    const terminal = snapshot.terminal
    if (!terminal) {
      return
    }
    const outcome = terminal.kind === 'settled' ? terminal.outcome : null
    const published =
      outcome && sub.grant && live(sub) && prDetailRecoveryGrantOwnsAlias(sub.owner, sub.grant)
        ? publishPRDetailRecoveryOutcome({
            set,
            get,
            identity: snapshot.identity,
            owner: sub.owner,
            grant: sub.grant,
            snapshot,
            outcome,
            isRuntime: sub.transport?.sourceEpoch.startsWith('runtime:') === true
          })
        : 'refused'
    const status = terminalRecoveryStatus(terminal, published !== 'refused', () =>
      hasUsableGitHubPR(get(), sub.context, sub.owner)
    )
    releasePRDetailRecoveryGrant(sub.owner, sub.grant)
    show(sub, status, true)
  }

  const observe = async (sub: Subscription, snapshot: PRDetailRecoverySnapshot): Promise<void> => {
    let latest: PRDetailRecoverySnapshot | null = snapshot
    while (latest && current === sub && !sub.cancelled) {
      if (latest.terminal) {
        settle(sub, latest)
        return
      }
      if (latest.phase === 'paused' && latest.notBefore !== undefined) {
        show(sub, { kind: 'paused', notBefore: latest.notBefore })
      } else {
        sub.admitted = latest.admitted
        show(sub, latest.admitted ? { kind: 'admitted' } : { kind: 'waiting' })
      }
      if (latest.phase === 'preparing' && !latest.publicationGrantId) {
        await prepare(sub, latest)
      }
      if (current !== sub || sub.cancelled) {
        return
      }
      latest = await sub.transport!.wait(latest.ticketId, latest.revision).catch(() => null)
    }
    if (current === sub && !sub.cancelled && !latest) {
      // A lost ticket or transport closes unknown; Retry or re-entry recovers.
      releasePRDetailRecoveryGrant(sub.owner, sub.grant)
      show(sub, { kind: 'failed' }, true)
    }
  }

  const run = async (sub: Subscription): Promise<void> => {
    const runtime = recoveryRuntimeTarget(get(), sub)
    sub.transport = await resolvePRDetailRecoveryTransport(runtime?.target.environmentId ?? null)
    if (current !== sub || sub.cancelled) {
      return
    }
    if (!sub.transport) {
      show(sub, { kind: 'unsupported' }, true)
      return
    }
    if (
      onPRDetailRecoveryAuthorityLost(sub.transport, () => {
        detach(sub)
        show(sub, { kind: 'closed' }, true)
      })
    ) {
      return
    }
    const inflight = inflightPRRequests.get(sub.owner.cacheKey)
    if (inflight) {
      show(sub, { kind: 'waiting' })
      // Another request's settlement is not this epoch's attempt; recheck before submitting.
      if (!(await awaitWithBudget(inflight.promise))) {
        show(sub, { kind: 'failed' }, true)
        return
      }
    }
    if (current !== sub || sub.cancelled) {
      return
    }
    if (!live(sub)) {
      show(sub, { kind: 'resolved' }, true)
      return
    }
    sub.releaseIntentPin = pinPRLookupIntent(sub.owner.cacheKey)
    sub.intentRevision = prLookupIntentRevision(sub.owner.cacheKey)
    const identity = buildPRDetailRecoveryIdentity(sub, sub.transport, runtime?.repo ?? null)
    epochCounter += 1
    const startArgs = {
      clientEpoch: { scope: EPOCH_SCOPE, counter: epochCounter },
      identity,
      cacheKey: sub.owner.cacheKey
    }
    const transport = sub.transport
    // A lost reply may hide an accepted start: resend the same epoch (host-idempotent), boundedly.
    const snapshot = await startWithResume(
      () => transport.start(startArgs),
      () => current === sub && !sub.cancelled && live(sub)
    )
    if (current !== sub || sub.cancelled) {
      if (snapshot?.ticketId) {
        void sub.transport.cancel(snapshot.ticketId).catch(() => {})
      }
      return
    }
    if (!snapshot) {
      show(sub, { kind: 'failed' }, true)
      return
    }
    sub.ticketId = snapshot.ticketId || null
    await observe(sub, snapshot)
  }

  return {
    prDetailRecovery: null,

    notePRDetailRecoveryPanelVisible: (visible) => {
      if (visible && !panelVisible) {
        retainedEpochs.clear()
      }
      panelVisible = visible
      if (!visible) {
        get().reconcileGitHubPRDetails(null)
      }
    },

    reconcileGitHubPRDetails: (context) => {
      const contextKey = context ? prDetailRecoveryContextKey(context) : null
      if (current && current.contextKey === contextKey && !current.cancelled) {
        return
      }
      if (current) {
        // An attempted context stays consumed for this exposure, even if left before it settled.
        if (current.ticketId && !retainedEpochs.get(current.contextKey)) {
          retainedEpochs.set(current.contextKey, { kind: 'closed' })
        }
        detach(current)
        current = null
      }
      const owner = context && panelVisible ? resolvePRDetailRecoveryOwner(get(), context) : null
      if (!context || !contextKey || !owner) {
        if (get().prDetailRecovery !== null) {
          set({ prDetailRecovery: null })
        }
        return
      }
      const retained = retainedEpochs.get(contextKey)
      if (retained) {
        if (get().prDetailRecovery?.contextKey !== contextKey) {
          set({ prDetailRecovery: { contextKey, status: retained, terminalCount: 0 } })
        }
        return
      }
      const sub: Subscription = newPRDetailRecoverySubscription(contextKey, context, owner, () => {
        detach(sub)
        show(sub, { kind: 'closed' }, true)
      })
      current = sub
      show(sub, { kind: 'waiting' })
      void run(sub).catch(() => show(sub, { kind: 'failed' }, true))
    },

    cancelGitHubPRDetailRecovery: () => {
      const contextKey = current?.contextKey ?? get().prDetailRecovery?.contextKey
      if (current) {
        detach(current)
        current = null
      }
      if (!contextKey) {
        return
      }
      // Retry owns the status line from here, including over a retained terminal outcome.
      record(contextKey, { kind: 'closed' }, 0)
    },

    settleGitHubPRDetailRetry: (contextKey, status, announce = true) => {
      if (!current && get().prDetailRecovery?.contextKey === contextKey) {
        record(contextKey, status, announce ? 1 : 0)
      }
    }
  }
}
