import type { Automation } from '../../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../../shared/automations/history/automation-run'
import type { AutomationReceiptRead } from '../../../../shared/automations/automation-receipt-read'
import type { AutomationOwnerPrecondition } from '../../../../shared/automations/ownership/automation-owner-precondition'
import {
  automationReceiptSourceCurrent,
  readAutomationReceipt,
  watchAutomationReceiptHost,
  type AutomationReceiptSource
} from './automation-receipt-client'
import {
  deleteReceiptAutomation,
  readReceiptRuns,
  runReceiptAutomation,
  updateReceiptAutomation
} from './automation-receipt-actions'

export type AutomationCardDetails = (
  | { status: 'loading' | 'unverified' | 'missing' | 'mismatch' | 'error' }
  | {
      status: 'ready'
      automation: Automation
      owner: AutomationOwnerPrecondition
      runs: AutomationRun[] | null
      effectiveZone?: string
    }
) & { acknowledgement?: 'deleted' }

type Transport = {
  current: () => boolean
  /** Calls `revoke` whenever the bound host may have changed; returns the unsubscribe. */
  watch?: (revoke: () => void) => () => void
  read: () => Promise<AutomationReceiptRead>
  runs: (automation: Automation, owner: AutomationOwnerPrecondition) => Promise<AutomationRun[]>
  update: (
    automation: Automation,
    owner: AutomationOwnerPrecondition,
    enabled: boolean
  ) => Promise<Automation>
  remove: (automation: Automation, owner: AutomationOwnerPrecondition) => Promise<boolean>
  run: (automation: Automation, owner: AutomationOwnerPrecondition) => Promise<void>
}

export function receiptDetailsTransport(source: AutomationReceiptSource): Transport {
  return {
    current: () => automationReceiptSourceCurrent(source),
    watch: (revoke) => watchAutomationReceiptHost(source, revoke),
    read: () => readAutomationReceipt(source),
    runs: (automation, owner) => readReceiptRuns(source, automation.id, owner),
    update: (automation, owner, enabled) =>
      updateReceiptAutomation(source, automation, owner, enabled),
    remove: (automation, owner) => deleteReceiptAutomation(source, automation, owner),
    run: (automation, owner) => runReceiptAutomation(source, automation, owner)
  }
}

/**
 * One intentional disclosure's lifetime. It reads current settings when opened (reopening makes a
 * new controller) and once more after its own Pause, Resume, Remove or Run settles. Changes made
 * elsewhere show on the next open: nothing re-reads in the background while it is open.
 * Mutation acknowledgements fence every earlier read.
 */
export class AutomationCardDetailsController {
  private state: AutomationCardDetails = { status: 'loading' }
  private listeners = new Set<() => void>()
  private readGeneration = 0
  private mutationGeneration = 0
  private disposed = false
  private bindingGeneration = 0
  private bindingValid = true
  private mutating = false
  private acknowledgement: 'deleted' | undefined
  private unwatch: (() => void) | null = null

  constructor(private readonly transport: Transport | null) {}

  start = (): void => {
    this.disposed = false
    this.watchHost()
    void this.reload()
  }

  /** Why: a hidden pane keeps its in-flight write, so a host change while hidden must still void it,
   *  even if the host looks the same again by the time the pane returns. */
  private watchHost(): void {
    if (!this.unwatch && this.transport?.watch) {
      this.unwatch = this.transport.watch(this.invalidate)
    }
  }

  private releaseHostWatch(): void {
    if (this.disposed && !this.mutating) {
      this.unwatch?.()
      this.unwatch = null
    }
  }

  getSnapshot = (): AutomationCardDetails => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish(next: AutomationCardDetails): void {
    this.state = {
      ...next,
      ...(this.acknowledgement ? { acknowledgement: this.acknowledgement } : {})
    }
    this.listeners.forEach((listener) => listener())
  }

  invalidate = (): void => {
    if (!this.bindingValid) {
      return
    }
    this.bindingGeneration++
    this.bindingValid = false
    this.readGeneration++
    this.mutationGeneration++
    this.acknowledgement = undefined
    this.publish({ status: 'unverified' })
  }

  reload = async (): Promise<void> => {
    const transport = this.transport
    if (this.disposed || !this.bindingValid) {
      return
    }
    if (!transport || !transport.current()) {
      this.invalidate()
      return
    }
    const read = ++this.readGeneration
    const mutation = this.mutationGeneration
    const accepts = () =>
      !this.disposed &&
      read === this.readGeneration &&
      mutation === this.mutationGeneration &&
      transport.current()
    try {
      const definition = await transport.read()
      if (!accepts()) {
        return
      }
      if (definition.status !== 'ready') {
        this.publish(definition)
        return
      }
      if (this.acknowledgement) {
        this.publish({ status: 'error' })
        return
      }
      const runs = await transport.runs(definition.automation, definition.owner).catch(() => null)
      if (accepts()) {
        this.publish({ ...definition, runs })
      }
    } catch {
      if (accepts()) {
        this.publish({ status: 'error' })
      }
    }
  }

  private ready(): Extract<AutomationCardDetails, { status: 'ready' }> {
    if (
      this.disposed ||
      this.mutating ||
      !this.bindingValid ||
      !this.transport?.current() ||
      this.state.status !== 'ready'
    ) {
      throw new Error('Reopen the receipt to check its host before making changes.')
    }
    return this.state
  }

  setEnabled = async (enabled: boolean): Promise<void> => {
    const { automation, owner } = this.ready()
    const binding = this.bindingGeneration
    this.mutating = true
    try {
      await this.transport!.update(automation, owner, enabled)
      if (binding !== this.bindingGeneration || !this.transport!.current()) {
        return
      }
      this.mutationGeneration++
      this.readGeneration++
      this.publish({ status: 'loading' })
    } catch (error) {
      // A write whose host binding was revoked is settled by the card's unverified state, not a toast.
      if (binding === this.bindingGeneration) {
        throw error
      }
    } finally {
      this.settleMutation(binding)
    }
  }

  remove = async (): Promise<void> => {
    const { automation, owner } = this.ready()
    const binding = this.bindingGeneration
    this.mutating = true
    try {
      const removed = await this.transport!.remove(automation, owner)
      if (binding !== this.bindingGeneration || !this.transport!.current()) {
        return
      }
      if (!removed) {
        if (this.disposed) {
          return
        }
        throw new Error('Automation was not removed. Reopen the receipt to check its state.')
      }
      this.mutationGeneration++
      this.readGeneration++
      // Definition removal does not establish the outcome of an already admitted run.
      this.acknowledgement = 'deleted'
      this.publish({ status: 'loading' })
    } catch (error) {
      if (binding === this.bindingGeneration) {
        throw error
      }
    } finally {
      this.settleMutation(binding)
    }
  }

  private settleMutation(binding: number): void {
    this.mutating = false
    this.releaseHostWatch()
    if (!this.disposed && binding === this.bindingGeneration && this.transport!.current()) {
      void this.reload()
    }
  }

  run = async (): Promise<void> => {
    const { automation, owner } = this.ready()
    const binding = this.bindingGeneration
    await this.transport!.run(automation, owner)
    if (!this.disposed && binding === this.bindingGeneration && this.transport!.current()) {
      void this.reload()
    }
  }

  /**
   * Ends this mount, which a hidden <Activity> pane may resume with start(). A mutation still in
   * flight keeps its binding: its acknowledgement fences every earlier read and its one post-ack
   * read runs now if mounted, else from start(). The host watch stays until that mutation settles,
   * so a re-pair, restart or refusal while hidden still voids it via invalidate().
   */
  dispose = (): void => {
    this.disposed = true
    this.readGeneration++
    this.listeners.clear()
    this.releaseHostWatch()
  }
}
