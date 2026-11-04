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
})
