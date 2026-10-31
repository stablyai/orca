import { expect, it, vi } from 'vitest'
import type { AgentSessionOptionsResult } from './agent-session-wire'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import { createStructuredAgentSessionOptionState } from './structured-agent-session-options'
import { createStructuredSessionSelectionController } from './structured-agent-session-selection-operations'
import { createStructuredAgentSessionOptionsReadOwner } from './structured-agent-session-options-read-owner'

const answer: AgentSessionOptionsResult = {
  models: [{ id: 'live', label: 'Live', isDefault: true, efforts: [] }],
  current: { model: 'live', permissionMode: 'ask', reportedPermissionMode: 'full-access' },
  acceptsImages: true
}
const tick = async () => {
  for (let n = 0; n < 12; n++) {
    await Promise.resolve()
  }
}
function fixture() {
  const optionCatalog = getAgentSessionOptionCatalog('codex')
  const seed = () => createStructuredAgentSessionOptionState('codex', optionCatalog)
  const reader = createStructuredAgentSessionOptionsReadOwner(seed())
  const controller = createStructuredSessionSelectionController(vi.fn())
  const reads: ReturnType<typeof Promise.withResolvers<AgentSessionOptionsResult>>[] = []
  let generation = 1
  const context = {
    owner: [controller],
    reset: [1],
    sessionId: 'chat',
    fence: 1,
    seed,
    controller,
    eligible: true,
    optionCatalog,
    newLaunch: false,
    coherentCatalog: true,
    authority: () => generation,
    isCurrent: () => true,
    accepted: vi.fn(),
    request: vi.fn(() => {
      const reply = Promise.withResolvers<AgentSessionOptionsResult>()
      reads.push(reply)
      return reply.promise
    })
  }
  return {
    reader,
    controller,
    reads,
    context,
    advance: () => {
      generation++
    }
  }
}

it('coalesces stale reads and publishes base/support/latch together before retiring only captured operations', async () => {
  const { reader, controller, reads, context, advance } = fixture()
  const close = reader.attach(context)
  const changed = vi.fn()
  const unsubscribe = reader.subscribe(changed)
  const initial = reader.getSnapshot()
  await tick()
  const pick = controller.issue('model', 'picked', null)
  controller.settle(pick, { kind: 'unknown' })
  for (let n = 0; n < 100; n++) {
    reader.invalidate()
  }
  expect(reads).toHaveLength(1)
  expect(changed).not.toHaveBeenCalled()
  advance()
  reads[0].resolve({ ...answer, acceptsImages: false })
  await tick()
  expect(reader.getSnapshot()).toBe(initial)
  expect(context.accepted).not.toHaveBeenCalled()
  expect(controller.overlay()).toEqual({ model: 'picked' })
  expect(reads).toHaveLength(2)
  const newer = controller.issue('effort', 'high', 'picked')
  controller.settle(newer, { kind: 'accepted', options: { effort: 'high' } })
  // A catalog arriving during the read must survive an unknown-inventory answer.
  reader.receiveCatalog({ origin: 'probe', fetchedAt: 1, models: answer.models }, 'settled')
  const catalog = reader.getSnapshot().optionState.catalog
  const stop = controller.subscribe(() => {
    expect(reader.getSnapshot().support?.result.acceptsImages).toBe(true)
    expect(reader.getSnapshot().optionState.optionsAnswerPresent).toBe(true)
  })
  reads[1].resolve({ ...answer, modelsKnown: false })
  await tick()
  expect(reader.getSnapshot().optionState.catalog).toBe(catalog)
  expect(context.accepted).toHaveBeenCalledTimes(1)
  expect(controller.captureRead()).toEqual([newer.identity])
  expect(controller.overlay()).toEqual({ effort: 'high' })
  stop()
  close()
  unsubscribe()
})

it('retains same-owner answers and permissions while resetting reports, and seeds a different owner but keeps its session-tagged support', async () => {
  const { reader, context, reads } = fixture()
  let close = reader.attach(context)
  await tick()
  reads[0].resolve(answer)
  await tick()
  const accepted = reader.getSnapshot()
  close()
  close = reader.attach({ ...context, reset: [2], fence: 2, eligible: false })
  const retained = reader.getSnapshot()
  expect(retained.optionState.record).not.toBe(accepted.optionState.record)
  expect(retained.optionState.catalog).toBe(accepted.optionState.catalog)
  expect(retained.optionState.permissionMode).toBe('ask')
  expect(retained.optionState.reportedPermissionMode).toBeUndefined()
  expect(retained.optionState.reportedEffort).toBeUndefined()
  expect(retained.support).toBe(accepted.support)
  reader.invalidate()
  reader.invalidate()
  expect(reads).toHaveLength(1)
  close()
  close = reader.attach({ ...context, reset: [2], fence: 2 })
  await tick()
  expect(reads).toHaveLength(2)
  close()
  const replacement = createStructuredSessionSelectionController(vi.fn())
  close = reader.attach({
    ...context,
    controller: replacement,
    owner: [replacement],
    eligible: false
  })
  expect(reader.getSnapshot().optionState.optionsAnswerPresent).toBeUndefined()
  expect(reader.getSnapshot().optionState.permissionMode).toBeNull()
  expect(reader.getSnapshot().support).toBe(accepted.support)
  reads[1].resolve({ ...answer, acceptsImages: false })
  await tick()
  expect(reader.getSnapshot().support).toBe(accepted.support)
  close()
})

it('releases failed or closed reads and starts a fresh lease at once while the old reply stays inert', async () => {
  const { reader, context, reads } = fixture()
  const close = reader.attach(context)
  await tick()
  reader.invalidate()
  close()
  const detach = reader.attach(context)
  close() // An old cleanup cannot close a newer lease.
  await tick()
  // The fresh lease does not wait behind the closed lease's request, whose queued read never runs.
  expect(reads).toHaveLength(2)
  reads[0].resolve({ ...answer, acceptsImages: false })
  await tick()
  expect(reads).toHaveLength(2)
  expect(reader.getSnapshot().support).toBeNull()
  reader.invalidate()
  reads[1].reject(new Error('offline'))
  await tick()
  expect(reads).toHaveLength(3)
  expect(context.accepted).not.toHaveBeenCalled()
  reads[2].resolve(answer)
  await tick()
  const accepted = reader.getSnapshot()
  reader.invalidate()
  await tick()
  reads[3].reject(new Error('offline'))
  await tick()
  expect(reader.getSnapshot()).toBe(accepted)
  reader.invalidate()
  await tick()
  expect(reads).toHaveLength(5)
  reader.invalidate()
  detach()
  reads[4].resolve({ ...answer, acceptsImages: false })
  await tick()
  expect(reads).toHaveLength(5)
  expect(reader.getSnapshot()).toBe(accepted)
  expect(context.accepted).toHaveBeenCalledTimes(1)
})

it('lets two live readers retire the same captured IDs without removing a newer pick', async () => {
  const { reader, context, controller, reads } = fixture()
  const older = controller.issue('model', 'picked', null)
  controller.settle(older, { kind: 'unknown' })
  const peer = createStructuredAgentSessionOptionsReadOwner(context.seed())
  const closes = [reader.attach(context), peer.attach(context)]
  await tick()
  const newer = controller.issue('effort', 'high', 'picked')
  controller.settle(newer, { kind: 'unknown' })
  for (const reply of reads) {
    reply.resolve(answer)
    await tick()
    expect(controller.overlay()).toEqual({ effort: 'high' })
    expect(controller.captureRead()).toEqual([newer.identity])
  }
  expect(reader.getSnapshot().support).not.toBeNull()
  expect(peer.getSnapshot().support).not.toBeNull()
  closes.forEach((close) => close())
})
