import type { DaemonSessionInventory } from './resource-session-inventory'
import {
  ptySessionIdentity,
  type PtyListedSession,
  type PtySessionLifecycle
} from '../../../../shared/pty-listed-session'
import { isResourceViewInactive } from '../../../../shared/resource-view-admission'
import { isProvenProcessExit } from '../../../../shared/terminal-exit-cause'
import { EMPTY_DAEMON_SESSION_INVENTORY, inventoryFromSessions } from './resource-session-inventory'

const COOLDOWN_MS = 100
const EXIT_PUBLICATION_MS = 50

/** One request survives view epochs, but only its dispatching epoch may publish it. */
export class ResourceSessionInventoryCache {
  private state: {
    sessionInventory: DaemonSessionInventory
    sessionsError: boolean
    observedAt: number | null
    loading: boolean
  } = {
    sessionInventory: EMPTY_DAEMON_SESSION_INVENTORY,
    sessionsError: false,
    observedAt: null,
    loading: false
  }
  private listeners = new Set<() => void>()
  private known = new Map<string, PtyListedSession>()
  private identitiesByIncarnation = new Map<string, Set<string>>()
  // Suppression belongs only to the current listing, never to later authoritative results.
  private tombstones = new Set<string>()
  private epoch = 0
  private active = false
  private pendingRefresh = false
  private inFlight: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private exitPublicationTimer: ReturnType<typeof setTimeout> | null = null
  private inventoryChanged = false
  private lastStarted = -Infinity

  constructor(
    private list: () => Promise<PtyListedSession[]>,
    private localOnly: boolean
  ) {}

  getSnapshot = () => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish(patch: Partial<typeof this.state>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) {
      listener()
    }
  }

  private publishInventory(patch: Partial<typeof this.state> = {}): void {
    if (this.exitPublicationTimer) {
      clearTimeout(this.exitPublicationTimer)
      this.exitPublicationTimer = null
    }
    this.inventoryChanged = false
    this.publish({
      ...patch,
      sessionInventory: inventoryFromSessions([...this.known.values()])
    })
  }

  setActive(active: boolean): void {
    if (active === this.active) {
      return
    }
    this.active = active
    this.epoch++
    this.pendingRefresh = false
    if (!active) {
      if (this.timer) {
        clearTimeout(this.timer)
      }
      this.timer = null
      if (this.state.loading) {
        this.publish({ loading: false })
      }
      return
    }
    if (this.inventoryChanged) {
      this.publishInventory()
    }
    void this.refresh()
  }

  dispose(): void {
    this.setActive(false)
    if (this.exitPublicationTimer) {
      clearTimeout(this.exitPublicationTimer)
      this.exitPublicationTimer = null
    }
  }

  invalidate = (): void => {
    if (this.active) {
      void this.refresh()
    }
  }

  clearError = (): void => {
    if (this.state.sessionsError) {
      this.publish({ sessionsError: false })
    }
  }

  refresh = (): Promise<void> => {
    if (!this.active) {
      return Promise.resolve()
    }
    if (this.inFlight) {
      this.pendingRefresh = true
      return this.inFlight
    }
    if (this.timer) {
      return Promise.resolve()
    }
    const remaining = this.lastStarted + COOLDOWN_MS - Date.now()
    if (remaining > 0) {
      this.timer = setTimeout(() => {
        this.timer = null
        void this.refresh()
      }, remaining)
      return Promise.resolve()
    }
    const epoch = this.epoch
    this.lastStarted = Date.now()
    const request = Promise.resolve()
      .then(() => {
        if (!this.active || epoch !== this.epoch) {
          return null
        }
        return this.list()
      })
      .then((sessions) => {
        if (!sessions || !this.active || epoch !== this.epoch) {
          return
        }
        const deduped = new Map<string, PtyListedSession>()
        const identitiesByIncarnation = new Map<string, Set<string>>()
        for (const session of sessions) {
          const identity = ptySessionIdentity(session)
          const incarnation = ptySessionIdentity({
            id: session.id,
            incarnationId: session.incarnationId
          })
          deduped.set(identity, session)
          const identities = identitiesByIncarnation.get(incarnation) ?? new Set<string>()
          identities.add(identity)
          identitiesByIncarnation.set(incarnation, identities)
        }
        for (const [incarnation, identities] of identitiesByIncarnation) {
          if (!this.tombstones.has(incarnation)) {
            continue
          }
          if (identities.size > 1) {
            this.pendingRefresh = true
            continue
          }
          for (const identity of identities) {
            deduped.delete(identity)
          }
          identitiesByIncarnation.delete(incarnation)
        }
        this.known = deduped
        this.identitiesByIncarnation = identitiesByIncarnation
        this.publishInventory({
          sessionsError: false,
          observedAt: Date.now()
        })
      })
      .catch((error: unknown) => {
        if (this.active && epoch === this.epoch && !isResourceViewInactive(error)) {
          this.publish({ sessionsError: true })
        }
      })
      .finally(() => {
        this.tombstones.clear()
        this.inFlight = null
        if (this.active && epoch === this.epoch) {
          this.publish({ loading: false })
        }
        if (this.active && this.pendingRefresh) {
          this.pendingRefresh = false
          void this.refresh()
        }
      })
    this.inFlight = request
    this.publish({ loading: true })
    return request
  }

  spawned(event: PtySessionLifecycle): void {
    if (this.localOnly && event.hostId !== 'local') {
      return
    }
    if (!event.incarnationId || !this.identitiesByIncarnation.has(ptySessionIdentity(event))) {
      this.invalidate()
    }
  }

  exited(event: PtySessionLifecycle & { code: number; ptySourceDisowned?: true }): void {
    if (this.localOnly && event.hostId !== 'local') {
      return
    }
    if (event.ptySourceDisowned || !isProvenProcessExit(event.code)) {
      return
    }
    const identities = this.identitiesByIncarnation.get(ptySessionIdentity(event))
    if (
      !event.incarnationId &&
      (this.localOnly ||
        (identities &&
          [...identities].some(
            (identity) => this.known.get(identity)?.inventorySourceId !== undefined
          )))
    ) {
      // A legacy exit cannot identify which daemon's same-id process exited.
      this.invalidate()
      return
    }
    this.inventoryChanged =
      this.removeIdentity(event.id, event.incarnationId) || this.inventoryChanged
    if (this.inventoryChanged && !this.exitPublicationTimer) {
      this.exitPublicationTimer = setTimeout(() => {
        this.exitPublicationTimer = null
        this.publishInventory()
      }, EXIT_PUBLICATION_MS)
    }
  }

  private removeIdentity(id: string, incarnationId?: string): boolean {
    const incarnation = ptySessionIdentity({ id, incarnationId })
    const identities = this.identitiesByIncarnation.get(incarnation)
    if (identities && identities.size > 1) {
      this.invalidate()
      return false
    }
    if (this.inFlight) {
      this.tombstones.add(incarnation)
    }
    const identity = identities?.values().next().value
    this.identitiesByIncarnation.delete(incarnation)
    if (identity === undefined) {
      return false
    }
    return this.known.delete(identity)
  }

  remove(id: string, incarnationId?: string): void {
    this.inventoryChanged = this.removeIdentity(id, incarnationId) || this.inventoryChanged
    if (this.inventoryChanged) {
      this.publishInventory()
    }
  }

  removeMany(sessions: readonly Pick<PtyListedSession, 'id' | 'incarnationId'>[]): void {
    let changed = false
    for (const session of sessions) {
      changed = this.removeIdentity(session.id, session.incarnationId) || changed
    }
    if (changed || this.inventoryChanged) {
      this.publishInventory()
    }
  }
}
