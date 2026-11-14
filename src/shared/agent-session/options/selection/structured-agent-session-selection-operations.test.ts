import { describe, expect, it, vi } from 'vitest'
import { createStructuredSessionSelectionController } from './structured-agent-session-selection-operations'

// Creation, attachment and revalidation share identities even when two picks have equal values.
describe('chat selection operation handoff', () => {
  it('freezes opening identities, supersedes unsent holds and issues attached picks before old replies', async () => {
    const remember = vi.fn()
    const controller = createStructuredSessionSelectionController(remember)
    const opening = controller.issue('model', 'opus', null)
    const frozen = controller.freeze()
    const model = controller.issue('model', 'sonnet', null)
    const oldEffort = controller.issue('effort', 'high', 'sonnet')
    controller.issue('effort', 'low', 'sonnet')
    await expect(oldEffort.result).resolves.toEqual({ kind: 'superseded' })
    const modelReply = Promise.withResolvers<void>()
    const send = vi.fn(async (op) => {
      if (op === model) {
        await modelReply.promise
      }
      return { kind: 'accepted' as const, options: { [op.key]: op.value } }
    })
    controller.flush(send)
    const sending = controller.drain()
    await Promise.resolve()
    controller.issue('effort', 'low', 'sonnet')
    const newerModel = controller.issue('model', 'opus', null)
    controller.issue('fastMode', 'true', 'opus')
    void controller.flush(send)
    controller.settle(frozen[0]!, { kind: 'accepted', options: { model: 'opus' } })
    expect(frozen).toEqual([opening])
    expect(controller.overlay()).toEqual({ model: 'opus', effort: 'low', fastMode: 'true' })
    expect(controller.pending()).toContain(newerModel)
    const beforeCompletion = controller.captureRead()
    modelReply.resolve()
    await sending
    controller.retire(beforeCompletion)
    expect(controller.overlay()).toEqual({ model: 'opus', effort: 'low', fastMode: 'true' })
    // The next complete answer can contain another client's newer values; equality is irrelevant.
    controller.retire(controller.captureRead())
    expect(controller.overlay()).toEqual({})
  })
})

it('drains abandoned writes without cancelling host acceptance or remembering late replies', async () => {
  const remember = vi.fn()
  const controller = createStructuredSessionSelectionController(remember)
  const reply = Promise.withResolvers<{ kind: 'accepted'; options: Record<string, string> }>()
  const operation = controller.issue('model', 'sonnet', null)
  controller.flush(() => reply.promise)
  const drained = controller.drain()
  controller.abandon()
  await drained
  await expect(operation.result).resolves.toEqual({ kind: 'superseded' })
  reply.resolve({ kind: 'accepted', options: { model: 'sonnet' } })
  await reply.promise
  await Promise.resolve()
  expect(controller.overlay()).toEqual({})
  expect(controller.captureRead()).toEqual([])
  expect(controller.isPending('model')).toBe(false)
  expect(controller.pendingId()).toBeNull()
})
