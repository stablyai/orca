import { describe, expect, it } from 'vitest'
import { createTerminalAgentStatusProcessor } from './terminal-agent-status-processor'

describe('createTerminalAgentStatusProcessor', () => {
  it('appends OSC 7501 projections, marks them, and leaves the sequence in the stream', () => {
    const process = createTerminalAgentStatusProcessor()
    const data = 'x\x1b]7501;state=working:app=codex\x1b\\y'
    const result = process(data)
    expect(result.cleanData).toBe(data)
    expect(result.payloads).toMatchObject([{ state: 'working', agentType: 'codex' }])
    expect(result.programStatusPayloads?.has(result.payloads[0])).toBe(true)
    expect(result.lastPayloadCleanOffset).toBe(data.length - 1)
  })

  it('merges OSC 9999 and OSC 7501 in one chunk, leaving titles untouched', () => {
    const process = createTerminalAgentStatusProcessor()
    const report = '\x1b]7501;state=working:app=claude-code\x1b\\'
    const result = process(
      `a\x1b]9999;{"state":"done","prompt":"p"}\x07${report}\x1b]0;Refactor\x07b`
    )
    expect(result.cleanData).toBe(`a${report}\x1b]0;Refactor\x07b`)
    expect(result.payloads).toMatchObject([{ state: 'done' }, { state: 'working' }])
    expect(result.programStatusPayloads?.has(result.payloads[1])).toBe(true)
    expect(result.programStatusPayloads?.has(result.payloads[0])).toBe(false)
    expect(result.lastPayloadCleanOffset).toBe(1 + report.length)
    expect(result.programStatusFacet).toMatchObject({ state: 'working' })
    expect(result.programActivity?.map((change) => change.activity)).toEqual(['working'])
  })

  it('reports each activity change once, and null when the program stops reporting', () => {
    const process = createTerminalAgentStatusProcessor()
    const osc = (body: string) => `\x1b]7501;${body}\x1b\\`
    const activity = (data: string) =>
      process(data).programActivity?.map((change) => change.activity)
    expect(activity(osc('state=idle:app=x') + osc('state=done:app=x'))).toEqual(['idle'])
    expect(activity(osc('state=blocked:kind=auth:app=x'))).toEqual(['permission'])
    expect(activity(osc('state=clear'))).toEqual([null])
  })

  it('places each activity change at the end of its report in the clean output', () => {
    const process = createTerminalAgentStatusProcessor()
    const report = '\x1b]7501;state=working:app=x\x1b\\'
    expect(process(`ab${report}cd`).programActivity).toEqual([
      { offset: 2 + report.length, activity: 'working' }
    ])
  })

  it('keeps OSC 9999 and OSC 7501 payloads in byte order', () => {
    const process = createTerminalAgentStatusProcessor()
    const osc9999Report = (state: string) => `\x1b]9999;{"state":"${state}"}\x07`
    const result = process(
      `${osc9999Report('working')}\x1b]7501;state=blocked:kind=question:app=x\x1b\\${osc9999Report('done')}`
    )
    expect(result.payloads.map((payload) => payload.state)).toEqual(['working', 'waiting', 'done'])
  })
})
