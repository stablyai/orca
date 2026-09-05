import { createBrowserUuid } from '../browser-uuid'
import {
  captureCreationDraftTarget,
  sendCreationDraft,
  type CreationDraftDeliveryResult
} from './creation-draft-delivery'
import {
  editCreationDraft,
  flushCreationDraft,
  useCreationDraftSession
} from './creation-draft-session'

export type CreationDraftSubmitResult =
  | CreationDraftDeliveryResult
  | { status: 'not-saved' | 'no-target' | 'already-attempted' }
const attempts = new Map<string, Promise<CreationDraftSubmitResult>>()

export function submitCreationDraft(id: string): Promise<CreationDraftSubmitResult> {
  const existing = attempts.get(id)
  if (existing) {
    return existing
  }
  const attempt = submit(id).finally(() => {
    attempts.delete(id)
  })
  attempts.set(id, attempt)
  return attempt
}

async function submit(id: string): Promise<CreationDraftSubmitResult> {
  await flushCreationDraft(id)
  const entry = useCreationDraftSession.getState().entries[id]
  if (
    !entry ||
    entry.error ||
    entry.savedVersion !== entry.editVersion ||
    entry.storedRevision === null
  ) {
    return { status: 'not-saved' }
  }
  if (entry.buffer.delivery) {
    return { status: 'already-attempted' }
  }
  const { buffer } = entry
  if (!buffer.target?.terminalHandle) {
    return { status: 'no-target' }
  }
  const baseTarget = {
    executionHostId: buffer.executionHostId,
    worktreeId: buffer.target.worktreeId,
    terminalHandle: buffer.target.terminalHandle
  }
  const identity = buffer.target.incarnationId
    ? { terminalHandle: buffer.target.terminalHandle, incarnationId: buffer.target.incarnationId }
    : await captureCreationDraftTarget(baseTarget)
  if (!identity) {
    return { status: 'no-target' }
  }
  // A new edit during target resolution requires another deliberate Send.
  if (useCreationDraftSession.getState().entries[id]?.editVersion !== entry.editVersion) {
    return { status: 'not-saved' }
  }
  const attemptId = createBrowserUuid()
  const delivery = { attemptId, revision: entry.storedRevision, state: 'sending' as const }
  editCreationDraft({
    ...buffer,
    target: { ...buffer.target, ...identity },
    delivery,
    updatedAt: Date.now()
  })
  await flushCreationDraft(id)
  const persisted = useCreationDraftSession.getState().entries[id]
  if (
    !persisted ||
    persisted.error ||
    persisted.savedVersion !== persisted.editVersion ||
    persisted.buffer.delivery?.attemptId !== attemptId
  ) {
    // No bytes were sent; clear only our unstarted attempt so saving can be retried.
    if (persisted?.buffer.delivery?.attemptId === attemptId) {
      editCreationDraft({ ...persisted.buffer, delivery: undefined, updatedAt: Date.now() })
      await flushCreationDraft(id)
    }
    return { status: 'not-saved' }
  }
  let result: CreationDraftDeliveryResult
  try {
    result = await sendCreationDraft({ target: { ...baseTarget, ...identity }, text: buffer.text })
  } catch {
    result = { status: 'uncertain', reason: 'transport' }
  }
  const current = useCreationDraftSession.getState().entries[id]
  if (current?.buffer.delivery?.attemptId === attemptId) {
    editCreationDraft({
      ...current.buffer,
      delivery: result.status === 'refused' ? undefined : { ...delivery, state: result.status },
      updatedAt: Date.now()
    })
    await flushCreationDraft(id)
  }
  return result
}
