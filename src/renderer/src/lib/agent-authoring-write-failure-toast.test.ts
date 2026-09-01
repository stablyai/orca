import { beforeEach, describe, expect, it, vi } from 'vitest'

const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }))

const { notifyAgentAuthoringWriteFailure } = await import('./agent-authoring-write-failure-toast')

type ToastCall = [string, { id: string; description: string }]

/** Widens a mutation result so the literal is checked against the mutation shape,
 *  not the narrower `{ ok }` the notifier accepts. */
function mutationResult(result: { ok: boolean; code?: string }): { ok: boolean } {
  return result
}

describe('notifyAgentAuthoringWriteFailure', () => {
  beforeEach(() => {
    toastError.mockClear()
  })

  it('stays silent when the mutation was persisted', () => {
    expect(notifyAgentAuthoringWriteFailure(mutationResult({ ok: true }))).toBeNull()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('stays silent for rejections that did not lose the change', () => {
    expect(
      notifyAgentAuthoringWriteFailure(
        mutationResult({ ok: false, code: 'reference_revision_conflict' })
      )
    ).toBeNull()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('reports catalog and reference durable-write failures under one toast id', () => {
    expect(
      notifyAgentAuthoringWriteFailure(
        mutationResult({ ok: false, code: 'agent_reference_write_failed' })
      )
    ).toBe('agent_reference_write_failed')
    expect(
      notifyAgentAuthoringWriteFailure(
        mutationResult({ ok: false, code: 'agent_catalog_write_failed' })
      )
    ).toBe('agent_catalog_write_failed')

    expect(toastError).toHaveBeenCalledTimes(2)
    const [title, options] = toastError.mock.calls[0] as ToastCall
    expect(title).toContain("wasn't saved")
    expect(options.description).toContain('try again')
    expect((toastError.mock.calls[1] as ToastCall)[1].id).toBe(options.id)
  })
})
