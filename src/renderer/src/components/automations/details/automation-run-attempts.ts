import type { AutomationOwnerRef } from '../../../../../shared/automations/ownership/automation-owner-ref'
import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'
import { translate } from '@/i18n/i18n'
import { evaluateAutomationOwner } from '../hosts/automation-host-owner'
import { automationActionOutcomeUnknown } from './automation-details-model'

export type AutomationRunAttempt = {
  owner: AutomationOwnerRef
  state: 'starting' | 'unconfirmed' | 'dismissed' | 'acknowledged'
  run?: AutomationRun
}

function key(owner: AutomationOwnerRef, automationId: string): string {
  const authority = owner.authority
  return JSON.stringify([
    authority.kind === 'runtime' ? authority.environmentId : null,
    owner.selector,
    automationId
  ])
}

function receipt(run: AutomationRun): AutomationRun {
  return {
    id: run.id,
    automationId: run.automationId,
    status: run.status,
    title: run.title.slice(0, 256),
    createdAt: run.createdAt,
    scheduledFor: run.scheduledFor,
    startedAt: run.startedAt,
    dispatchedAt: run.dispatchedAt,
    trigger: run.trigger,
    sessionKind: run.sessionKind,
    workspaceId: null,
    chatSessionId: null,
    terminalSessionId: null,
    terminalPaneKey: null,
    terminalPtyId: null,
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null
  }
}

/** Uncertain attempts survive navigation; only a reply, retirement, or explicit retry replaces custody. */
export class AutomationRunAttempts {
  private readonly entries = new Map<string, AutomationRunAttempt>()
  private readonly listeners = new Set<() => void>()
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private emit(): void {
    this.listeners.forEach((listener) => listener())
  }
  private matches(a: AutomationOwnerRef, b: AutomationOwnerRef): boolean {
    if (JSON.stringify(a) === JSON.stringify(b)) {
      return true
    }
    const left = evaluateAutomationOwner(a)
    const right = evaluateAutomationOwner(b)
    return (
      (left.status === 'same' || left.status === 'continued') &&
      (right.status === 'same' || right.status === 'continued') &&
      JSON.stringify(left.owner) === JSON.stringify(right.owner)
    )
  }
  get(owner: AutomationOwnerRef, automationId: string): AutomationRunAttempt | null {
    const attempt = this.entries.get(key(owner, automationId))
    if (!attempt || !this.matches(owner, attempt.owner)) {
      return null
    }
    const proof = evaluateAutomationOwner(attempt.owner)
    return proof.status === 'retired' || proof.status === 'unpaired' ? null : attempt
  }
  dismiss(owner: AutomationOwnerRef, automationId: string): void {
    const attempt = this.get(owner, automationId)
    if (attempt?.state !== 'unconfirmed') {
      return
    }
    this.entries.set(key(owner, automationId), { ...attempt, state: 'dismissed' })
    this.emit()
  }
  retire(owner: AutomationOwnerRef, automationId: string): void {
    const id = key(owner, automationId)
    const attempt = this.entries.get(id)
    if (attempt && this.matches(owner, attempt.owner) && this.entries.delete(id)) {
      this.emit()
    }
  }
  async start(
    owner: AutomationOwnerRef,
    automationId: string,
    action: () => Promise<AutomationRun>
  ): Promise<AutomationRun> {
    for (const [id, entry] of this.entries) {
      const proof = evaluateAutomationOwner(entry.owner)
      if (proof.status === 'retired' || proof.status === 'unpaired') {
        this.entries.delete(id)
      }
    }
    const id = key(owner, automationId)
    const previous = this.entries.get(id)
    if (previous && previous.state !== 'dismissed') {
      throw new Error(
        translate('bots.automationPanel.unconfirmed', "Couldn't confirm the run started")
      )
    }
    if (!previous && this.entries.size >= 32) {
      throw new Error(
        translate(
          'bots.automationPanel.detailCapacity',
          'Open in Automations to read more details.'
        )
      )
    }
    const attempt: AutomationRunAttempt = { owner, state: 'starting' }
    this.entries.set(id, attempt)
    this.emit()
    try {
      const run = await action()
      if (this.entries.get(id) === attempt) {
        this.entries.set(id, { owner, state: 'acknowledged', run: receipt(run) })
        this.emit()
      }
      return run
    } catch (error) {
      if (this.entries.get(id) === attempt) {
        if (automationActionOutcomeUnknown(error)) {
          this.entries.set(id, { owner, state: 'unconfirmed' })
        } else {
          this.entries.delete(id)
        }
        this.emit()
      }
      throw error
    }
  }
}

export const automationRunAttempts = new AutomationRunAttempts()
