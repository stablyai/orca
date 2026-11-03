import { useAppStore } from '@/store'
import {
  getRuntimeEnvironmentRevision,
  onRuntimeEnvironmentRevisionsChanged,
  onRuntimeEnvironmentsRetired
} from '@/runtime/runtime-environment-revision'
import { SharedControlReconnectScheduler } from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-reconnect'
import {
  runtimeHostContactForEntry,
  lastRuntimeHostAnswer
} from '../../../../shared/runtime-host-contact'
import { REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY } from '../../../../shared/protocol-version'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { CrewSubscriptionAttemptArgs } from '../../../../shared/runtime-environment-subscription-setup'
import { CrewSubscription, UNKNOWN_CREW } from './orchestration-crew-subscription'

type SourceSelection = {
  identity: string
  wake: string
  initial: boolean
  retry?: Omit<CrewSubscriptionAttemptArgs, 'subscriptionId' | 'method' | 'timeoutMs' | 'params'>
}

function selectSource(target: RuntimeClientTarget): SourceSelection {
  if (target.kind === 'local') {
    return { identity: 'local', wake: 'local', initial: true }
  }
  const entry = useAppStore.getState().runtimeStatusByEnvironmentId.get(target.environmentId)
  const revision = getRuntimeEnvironmentRevision(target.environmentId)
  const contact = runtimeHostContactForEntry(entry)
  const status = lastRuntimeHostAnswer(contact)
  const snapshot = entry?.snapshot
  const initial = contact.verdict === 'live'
  const capable = status?.capabilities?.includes(REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY) ?? false
  return {
    identity: JSON.stringify([revision, status?.runtimeId, entry?.connectionGeneration]),
    wake: JSON.stringify([
      contact.verdict,
      snapshot?.verification,
      snapshot?.transport,
      entry?.hostContactEpoch,
      capable
    ]),
    initial,
    ...(initial &&
    capable &&
    revision !== undefined &&
    snapshot?.verification === 'verified' &&
    snapshot.transport === 'ready' &&
    snapshot.pairingRevision === revision &&
    snapshot.status?.runtimeId === status?.runtimeId &&
    !snapshot.retired &&
    status
      ? {
          retry: {
            selector: target.environmentId,
            expectedEnvironmentPairingRevision: revision,
            expectedEnvironmentRuntimeId: status.runtimeId
          }
        }
      : {})
  }
}

// This is the existing counted entries owner, grouped by selected source within this document.
const entries = new Map<string, CrewFollowSource>()

export class CrewFollowSource {
  readonly interests = new Map<string, CrewSubscription>()
  current: SourceSelection
  private readonly scheduler = new SharedControlReconnectScheduler()
  private dispose: (() => void) | undefined
  private blocked = false
  private unsupported = false
  private retiredIdentity: string | undefined

  constructor(
    readonly target: RuntimeClientTarget,
    private readonly onIdle: () => void
  ) {
    this.current = selectSource(target)
  }

  interest(party: string): CrewSubscription {
    let interest = this.interests.get(party)
    if (!interest) {
      interest = new CrewSubscription(this, party)
      this.interests.set(party, interest)
    }
    return interest
  }

  retain(interest: CrewSubscription): void {
    this.interests.set(interest.party, interest)
    if (!this.dispose) {
      const changed = (ids: readonly string[]): void => {
        if (this.target.kind === 'environment' && ids.includes(this.target.environmentId)) {
          this.update()
        }
      }
      const retire = onRuntimeEnvironmentsRetired((ids) => {
        if (this.target.kind === 'environment' && ids.includes(this.target.environmentId)) {
          this.retiredIdentity = this.current.identity
          this.block(false)
        }
      })
      const revisions = onRuntimeEnvironmentRevisionsChanged(changed)
      const store = useAppStore.subscribe(() => this.update())
      const gone = (): void => {
        this.retiredIdentity = this.current.identity
        this.block(false)
        this.dispose?.()
        this.dispose = undefined
      }
      window.addEventListener('pagehide', gone)
      this.dispose = () => {
        retire()
        revisions()
        store()
        window.removeEventListener('pagehide', gone)
      }
      this.update()
    }
    if (
      !this.blocked &&
      !this.unsupported &&
      this.current.identity !== this.retiredIdentity &&
      interest.state === 'idle'
    ) {
      interest.start()
    }
  }

  private update(): void {
    const next = selectSource(this.target)
    const replaced = next.identity !== this.current.identity
    const wake = next.wake !== this.current.wake
    this.current = next
    if (!replaced && !wake) {
      return
    }
    this.scheduler.clear()
    if (replaced || !next.initial) {
      for (const interest of this.interests.values()) {
        interest.retire()
      }
    }
    if (!next.initial || next.identity === this.retiredIdentity) {
      return
    }
    this.blocked = false
    this.unsupported = false
    // Only a real selected source/contact transition wakes parked interests.
    for (const interest of this.interests.values()) {
      interest.wake()
    }
  }

  block(unsupported: boolean): void {
    this.blocked = true
    this.unsupported ||= unsupported
    this.scheduler.clear()
    for (const interest of this.interests.values()) {
      interest.retire()
    }
  }

  schedule(): void {
    if (
      this.blocked ||
      this.unsupported ||
      this.current.identity === this.retiredIdentity ||
      (this.target.kind === 'environment' && !this.current.retry)
    ) {
      return
    }
    this.scheduler.scheduleWithDefaultBackoff(false, () => {
      for (const interest of this.interests.values()) {
        if (interest.state === 'waiting') {
          interest.start()
        }
      }
    })
  }

  completed(): void {
    this.scheduler.resetAttempt()
  }

  release(interest: CrewSubscription): void {
    if (this.interests.get(interest.party) === interest) {
      this.interests.delete(interest.party)
    }
    if (![...this.interests.values()].some((entry) => entry.state === 'waiting')) {
      this.scheduler.clear()
    }
    if (this.interests.size === 0) {
      this.scheduler.clear()
      this.dispose?.()
      this.dispose = undefined
      if (!this.unsupported) {
        this.onIdle()
      }
    }
  }
}

function crewInterest(target: RuntimeClientTarget, party: string): CrewSubscription {
  const key = target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
  let source = entries.get(key)
  if (!source) {
    const created = new CrewFollowSource(target, () => {
      if (entries.get(key) === created) {
        entries.delete(key)
      }
    })
    source = created
    entries.set(key, source)
  }
  return source.interest(party)
}

export function observeCrew(target: RuntimeClientTarget, party: string) {
  let entry: CrewSubscription | undefined
  return {
    subscribe: (listener: () => void): (() => void) => {
      entry = crewInterest(target, party)
      return entry.subscribe(listener)
    },
    read: () => entry?.read() ?? UNKNOWN_CREW
  }
}
