import type { Automation } from '../../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../../shared/automations/history/automation-run'
import type { AutomationReceiptRead } from '../../../../shared/automations/automation-receipt-read'
import type { AutomationOwnerPrecondition } from '../../../../shared/automations/ownership/automation-owner-precondition'
import type { WebhookKey } from '../../../../shared/rpc-contract/webhooks-params'
import { automationWebhookTrigger } from '../../../../shared/automation-event-triggers'
import { hookIdOfRule } from '../../../../shared/connector-webhook-contract'
import {
  automationReceiptSourceCurrent,
  deleteReceiptAutomation,
  readAutomationReceipt,
  readReceiptRuns,
  readReceiptWebhookKey,
  runReceiptAutomation,
  updateReceiptAutomation,
  type AutomationReceiptSource
} from './automation-receipt-client'

export type AutomationCardDetails = (
  | { status: 'loading' | 'unverified' | 'missing' | 'mismatch' | 'error' }
  | {
      status: 'ready'
      automation: Automation
      owner: AutomationOwnerPrecondition
      runs: AutomationRun[] | null
      effectiveZone?: string
    }
) & { acknowledgement?: 'cancelled' | 'deleted' }

type Transport = {
  current: () => boolean
  read: () => Promise<AutomationReceiptRead>
  runs: (automation: Automation, owner: AutomationOwnerPrecondition) => Promise<AutomationRun[]>
  update: (
    automation: Automation,
    owner: AutomationOwnerPrecondition,
    enabled: boolean
  ) => Promise<Automation>
  remove: (automation: Automation, owner: AutomationOwnerPrecondition) => Promise<void>
  run: (automation: Automation, owner: AutomationOwnerPrecondition) => Promise<void>
  webhookKey?: (hookId: string) => Promise<WebhookKey>
}

export function receiptDetailsTransport(source: AutomationReceiptSource): Transport {
  return {
    current: () => automationReceiptSourceCurrent(source),
    read: () => readAutomationReceipt(source),
    runs: (automation, owner) => readReceiptRuns(source, automation.id, owner),
    update: (automation, owner, enabled) =>
      updateReceiptAutomation(source, automation, owner, enabled),
    remove: (automation, owner) => deleteReceiptAutomation(source, automation, owner),
    run: (automation, owner) => runReceiptAutomation(source, automation, owner),
    webhookKey: (hookId) => readReceiptWebhookKey(source, hookId)
  }
}

/** One intentional disclosure's lifetime. Mutation acknowledgements fence every earlier read. */
export class AutomationCardDetailsController {
  private state: AutomationCardDetails = { status: 'loading' }
  private listeners = new Set<() => void>()
  private readGeneration = 0
  private mutationGeneration = 0
  private disposed = false
  private bindingGeneration = 0
  private bindingValid = true
  private mutating = false
  private acknowledgement: 'cancelled' | 'deleted' | undefined

  constructor(private readonly transport: Transport | null) {}

  start = (): void => {
    this.disposed = false
    void this.reload()
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

  changed = (): void => {
    this.mutationGeneration++
    if (!this.mutating) {
      void this.reload()
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
      if (this.disposed || binding !== this.bindingGeneration || !this.transport!.current()) {
        return
      }
      this.mutationGeneration++
      this.readGeneration++
      this.publish({ status: 'loading' })
    } finally {
      this.mutating = false
      if (!this.disposed && binding === this.bindingGeneration && this.transport!.current()) {
        void this.reload()
      }
    }
  }

  remove = async (): Promise<void> => {
    const { automation, owner } = this.ready()
    const binding = this.bindingGeneration
    this.mutating = true
    try {
      await this.transport!.remove(automation, owner)
      if (this.disposed || binding !== this.bindingGeneration || !this.transport!.current()) {
        return
      }
      this.mutationGeneration++
      this.readGeneration++
      this.acknowledgement = automation.once ? 'cancelled' : 'deleted'
      this.publish({ status: 'loading' })
    } finally {
      this.mutating = false
      if (!this.disposed && binding === this.bindingGeneration && this.transport!.current()) {
        void this.reload()
      }
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

  dispose = (): void => {
    this.disposed = true
    this.bindingGeneration++
    this.readGeneration++
    this.listeners.clear()
  }

  copyWebhookUrl = async (copy: (url: string) => void): Promise<void> => {
    const { automation } = this.ready()
    const trigger = automationWebhookTrigger(automation)
    const hookId = trigger && hookIdOfRule(trigger.id)
    if (!hookId || !this.transport?.webhookKey) {
      return
    }
    const binding = this.bindingGeneration
    const mutation = this.mutationGeneration
    const read = this.readGeneration
    const key = await this.transport.webhookKey(hookId)
    if (
      !this.disposed &&
      binding === this.bindingGeneration &&
      mutation === this.mutationGeneration &&
      read === this.readGeneration &&
      this.transport.current()
    ) {
      copy(key.url)
    }
  }
}
