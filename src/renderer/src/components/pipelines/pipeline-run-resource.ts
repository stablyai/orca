import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import type { PipelineV2Receipt } from '../../../../shared/pipelines/v2/pipeline-v2-results'
import type { PipelineV2OwnerSynchronizeInput } from '../../../../shared/pipelines/v2/pipeline-v2-owner-contracts'
import {
  preparePipelineSynchronization,
  readPipelineSynchronizationReceipt
} from './pipeline-run-synchronization'
import { readPipelineRun, type PipelineRunRead, type PipelineRunScope } from './pipeline-run-read'
import { subscribePipelineRunChanges } from './pipeline-run-events'
import { applyPipelineRunReceipt } from './pipeline-run-projection'
import { pipelineRunActionRejected } from './pipeline-run-rejections'
import { composeWorktreeId, worktreeIdsEqual } from '../../../../shared/worktree/id'
import { pipelineRunResources as resources } from './pipeline-run-cache'
import {
  preparePipelineRunAction,
  performPipelineRunAction,
  readPipelineRunActionReceipt,
  type PipelineRunAction,
  type PipelineRunOperation
} from './pipeline-run-actions'

export type PipelineRunState = {
  read?: PipelineRunRead
  loading: boolean
  busy: boolean
  error?: string
  actionError?: string
  pending?: PipelineRunOperation
  synchronization?: PipelineV2OwnerSynchronizeInput
  receipt?: PipelineV2Receipt
  comment: string
  discussion: string
}
export class PipelineRunResource {
  state: PipelineRunState = { loading: true, busy: false, comment: '', discussion: '' }
  readonly listeners = new Set<() => void>()
  private detach?: () => void
  private reading?: Promise<void>
  private readAgain = false
  constructor(
    readonly scope: PipelineRunScope,
    readonly capacity = false
  ) {
    if (capacity) {
      this.state = { ...this.state, loading: false, error: 'pipeline_retention_capacity' }
    }
  }
  private patch(patch: Partial<PipelineRunState>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((listener) => listener())
  }
  subscribe = (listener: () => void) => {
    if (this.capacity) {
      return () => {}
    }
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      this.detach = subscribePipelineRunChanges(
        (event) => {
          if (
            event.type === 'reconnect' ||
            (event.type === 'worktreeFilesChanged' &&
              this.state.read?.status.currentEvidence &&
              worktreeIdsEqual(
                composeWorktreeId(this.scope.projectId, event.worktreePath),
                this.state.read.status.run.workspace.id
              )) ||
            (event.type === 'gitStatusChanged' &&
              event.repoId === this.scope.projectId &&
              (!event.worktreeIds ||
                !this.state.read ||
                event.worktreeIds.includes(this.state.read.status.run.workspace.id))) ||
            (event.type === 'pipelinesChanged' &&
              event.runId === this.scope.runId &&
              event.projectId === this.scope.projectId &&
              event.instanceId === this.scope.workspaceInstanceId)
          ) {
            void this.refresh()
          }
        },
        (error) => this.patch({ error: String(error) })
      )
      void this.refresh()
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        this.detach?.()
        this.detach = undefined
      }
    }
  }
  snapshot = () => this.state
  refresh = (): Promise<void> => {
    if (this.capacity) {
      return Promise.resolve()
    }
    if (this.reading) {
      this.readAgain = true
      return this.reading
    }
    this.patch({ loading: !this.state.read })
    this.reading = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        this.readAgain = false
        try {
          const read = await readPipelineRun(this.scope, this.state.read?.definition)
          this.patch({ read, loading: false, error: undefined })
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === 'pipeline_snapshot_changed' &&
            attempt < 2
          ) {
            this.readAgain = true
          } else {
            this.patch({
              loading: false,
              error: error instanceof Error ? error.message : String(error)
            })
          }
        }
        if (!this.readAgain) {
          break
        }
      }
    })().finally(() => {
      this.reading = undefined
      if (this.readAgain && this.listeners.size) {
        queueMicrotask(() => {
          void this.refresh()
        })
      }
    })
    return this.reading
  }
  setText = (field: 'comment' | 'discussion', value: string) => this.patch({ [field]: value })
  setActionError = (error: string | undefined) => this.patch({ actionError: error })
  private acceptReceipt(operation: PipelineRunOperation, receipt: PipelineV2Receipt) {
    const base = operation.base
    if (
      receipt.requestId !== base.requestId ||
      receipt.runId !== this.scope.runId ||
      receipt.workspaceInstanceId !== this.scope.workspaceInstanceId ||
      receipt.kind !== operation.command.kind ||
      receipt.inputRevision !== base.expectedRevision ||
      receipt.acceptedRevision !== base.expectedRevision + 1
    ) {
      throw new Error('pipeline_receipt_conflict')
    }
    if (
      operation.command.kind === 'decide' &&
      (receipt.candidateId !== operation.command.candidateId ||
        receipt.candidateDigest !== operation.command.candidateDigest)
    ) {
      throw new Error('pipeline_receipt_conflict')
    }
    this.patch({
      pending: undefined,
      receipt,
      actionError: undefined,
      ...(this.state.read
        ? {
            read: {
              ...this.state.read,
              projection: applyPipelineRunReceipt(this.state.read.projection, receipt)
            }
          }
        : {}),
      ...(operation.command.kind === 'decide' &&
      this.state.comment === (operation.command.comment ?? '')
        ? { comment: '' }
        : {})
    })
  }
  act = async (action: PipelineRunAction, shown = this.state.read): Promise<boolean> => {
    if (this.state.busy || !shown || this.state.synchronization) {
      return false
    }
    if (this.state.pending) {
      await this.reconcile()
      return false
    }
    if (this.state.error) {
      this.patch({ actionError: this.state.error })
      return false
    }
    let operation: PipelineRunOperation
    try {
      operation = preparePipelineRunAction(this.scope, shown, action, createBrowserUuid())
    } catch (error) {
      this.patch({ actionError: String(error) })
      return false
    }
    this.patch({ busy: true, pending: operation, actionError: undefined })
    try {
      this.acceptReceipt(operation, await performPipelineRunAction(operation))
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const rejected = pipelineRunActionRejected(message)
      this.patch({ actionError: message, ...(rejected ? { pending: undefined } : {}) })
      return false
    } finally {
      this.patch({ busy: false })
      await this.refresh()
    }
  }
  synchronize = async (shown: PipelineRunRead) => {
    if (this.state.busy || this.state.pending) {
      return
    }
    if (!this.state.synchronization && this.state.error) {
      this.patch({ actionError: this.state.error })
      return
    }
    const retrying = Boolean(this.state.synchronization)
    let input: PipelineV2OwnerSynchronizeInput
    try {
      input =
        this.state.synchronization ??
        preparePipelineSynchronization(this.scope, shown, createBrowserUuid())
    } catch (error) {
      this.patch({ actionError: String(error) })
      return
    }
    this.patch({ busy: true, synchronization: input, actionError: undefined })
    const reconciling = input.expectedRuntimeId !== shown.runtimeId
    try {
      const outcome = reconciling
        ? await readPipelineSynchronizationReceipt(this.scope, input, shown)
        : (await window.api.pipelineOwner.synchronize(input)).state
      if (outcome === 'ready' || outcome === 'not_started') {
        this.patch({
          synchronization: undefined,
          actionError: outcome === 'not_started' ? 'pipeline_launch_refused' : undefined
        })
      } else {
        this.patch({ actionError: 'pipeline_synchronization_unconfirmed' })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.patch({
        actionError: message,
        ...(!reconciling &&
        pipelineRunActionRejected(message) &&
        !(retrying && message.includes('pipeline_runtime_identity_changed'))
          ? { synchronization: undefined }
          : {})
      })
    } finally {
      this.patch({ busy: false })
      await this.refresh()
    }
  }
  reconcile = async () => {
    const operation = this.state.pending
    if (!operation || this.state.busy || !this.state.read) {
      return
    }
    this.patch({ busy: true })
    try {
      const receipt = await readPipelineRunActionReceipt(operation, this.state.read.runtimeId)
      if (!receipt) {
        throw new Error(
          'The action is not confirmed. Its request is retained; no action was repeated.'
        )
      }
      this.acceptReceipt(operation, receipt)
    } catch (error) {
      this.patch({ actionError: error instanceof Error ? error.message : String(error) })
    } finally {
      this.patch({ busy: false })
      await this.refresh()
    }
  }
}
export function pipelineRunResource(scope: PipelineRunScope) {
  const key = JSON.stringify([scope.projectId, scope.workspaceInstanceId, scope.runId])
  const existing = resources.get(key)
  if (existing) {
    return existing
  }
  if (resources.size >= 16) {
    const unused = [...resources].find(
      ([, entry]) =>
        entry.listeners.size === 0 &&
        !entry.state.pending &&
        !entry.state.synchronization &&
        !entry.state.comment &&
        !entry.state.discussion
    )
    if (!unused) {
      return new PipelineRunResource(scope, true)
    }
    resources.delete(unused[0])
  }
  const created = new PipelineRunResource(scope)
  resources.set(key, created)
  return created
}
