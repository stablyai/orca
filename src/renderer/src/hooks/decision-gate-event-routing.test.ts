import { describe, expect, it, vi } from 'vitest'
import { routeDecisionGateChange } from './decision-gate-event-routing'

function notifications() {
  return {
    dispatch: vi.fn(async () => ({ delivered: true as const })),
    dismiss: vi.fn(async () => ({ dismissed: 1 }))
  }
}

describe('decision gate event routing', () => {
  it('dispatches one notification for a local persisted gate event', () => {
    const api = notifications()
    const emitChanged = vi.fn()

    routeDecisionGateChange({ gateId: 'gate_1', question: 'Proceed?' }, api, emitChanged)

    expect(api.dispatch).toHaveBeenCalledOnce()
    expect(api.dispatch).toHaveBeenCalledWith({
      source: 'orchestration-attention',
      notificationId: 'gate_1',
      gateId: 'gate_1',
      question: 'Proceed?'
    })
    expect(emitChanged).toHaveBeenCalledOnce()
  })

  it('refreshes a remote snapshot without emitting another OS/mobile notification', () => {
    const api = notifications()
    const emitChanged = vi.fn()

    routeDecisionGateChange({}, api, emitChanged)

    expect(api.dispatch).not.toHaveBeenCalled()
    expect(api.dismiss).not.toHaveBeenCalled()
    expect(emitChanged).toHaveBeenCalledWith({})
  })

  it('dismisses resolved attention and refreshes once', () => {
    const api = notifications()
    const emitChanged = vi.fn()

    routeDecisionGateChange({ resolvedGateId: 'gate_1' }, api, emitChanged)

    expect(api.dismiss).toHaveBeenCalledWith(['gate_1'])
    expect(emitChanged).toHaveBeenCalledOnce()
  })
})
