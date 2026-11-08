import { describe, expect, it } from 'vitest'
import { createProgramStatusProjector } from './agent-status-projector'

const osc = (body: string): string => `\x1b]7501;${body}\x1b\\`

function lastRootStates(data: string[]) {
  const projector = createProgramStatusProjector(() => 1000)
  return data.map((chunk) => {
    const payloads = projector.process(chunk).payloads
    const last = payloads.at(-1)?.payload
    return last && { state: last.state, sessionBoundary: last.sessionBoundary }
  })
}

describe('createProgramStatusProjector', () => {
  it('ends an OpenCode turn on idle but not its startup', () => {
    // Captured from OpenCode 2.2.5, which never reports done.
    const session = 'ses_e57cc6093ffeU9dbfhOFmwKNgt'
    expect(
      lastRootStates([
        osc('state=idle:app=opencode'),
        osc('state=working:app=opencode') + osc(`state=working:id=${session}:app=opencode`),
        osc(`state=clear:id=${session}`) + osc('state=idle:app=opencode')
      ])
    ).toEqual([
      { state: 'done', sessionBoundary: true },
      { state: 'working', sessionBoundary: undefined },
      { state: 'done', sessionBoundary: undefined }
    ])
  })

  it('ignores top-level OpenCode service session records as subagents while keeping hierarchical child sessions', () => {
    const projector = createProgramStatusProjector(() => 1000)
    const siblingA = 'ses_4sxfcEbQ8hnQuO'
    const siblingB = 'ses_9kLmNpQrSpJQGKF'
    const msgBase64 = Buffer.from('2 sessions working').toString('base64')
    const workingChunk =
      osc(`state=working:app=opencode:msg=${msgBase64}`) +
      osc(`state=working:id=${siblingA}:app=opencode`) +
      osc(`state=working:id=${siblingB}:app=opencode`)
    const workingPayload = projector.process(workingChunk).payloads.at(-1)?.payload
    expect(workingPayload?.state).toBe('working')
    expect(workingPayload?.toolInput).toBe('2 sessions working')
    expect(workingPayload?.subagents).toBeUndefined()

    const idlePayload = projector.process(osc('state=idle:app=opencode')).payloads.at(-1)?.payload
    expect(idlePayload?.state).toBe('done')
    expect(idlePayload?.subagents).toBeUndefined()
    expect(idlePayload?.mainAgent?.state).toBe('done')

    const childId = `${siblingA}/ses_childSubagent01`
    const withChildPayload = projector
      .process(
        osc('state=working:app=opencode') +
          osc(`state=working:id=${siblingA}:app=opencode`) +
          osc(`state=working:id=${childId}:app=opencode`)
      )
      .payloads.at(-1)?.payload
    expect(withChildPayload?.state).toBe('working')
    expect(withChildPayload?.subagents).toEqual([
      {
        id: childId,
        state: 'working',
        startedAt: 1000,
        agentType: 'opencode'
      }
    ])
  })
})
