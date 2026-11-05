import { describe, expect, it } from 'vitest'
import { PROGRAM_STATUS_MAX_RECORDS, ProgramStatusRecordSet } from './records'

describe('ProgramStatusRecordSet', () => {
  it('replaces a record whole on each report', () => {
    const records = new ProgramStatusRecordSet()
    records.apply({ id: null, state: 'working', app: 'brew', msg: 'Installing' })
    records.apply({ id: null, state: 'done' })
    expect(records.root()).toEqual({ id: null, state: 'done' })
  })

  it('inherits app from the nearest ancestor that has one', () => {
    const records = new ProgramStatusRecordSet()
    records.apply({ id: null, state: 'working', app: 'deploy' })
    records.apply({ id: 'us-east', state: 'working', title: 'US East' })
    records.apply({ id: 'us-east/push', state: 'blocked', kind: 'permission' })
    records.apply({ id: 'other', state: 'working', app: 'own' })
    expect(records.descendants().map((record) => [record.id, record.app])).toEqual([
      ['us-east', 'deploy'],
      ['us-east/push', 'deploy'],
      ['other', 'own']
    ])
  })

  it('clears an id and everything beneath it, and a bare clear removes all', () => {
    const records = new ProgramStatusRecordSet()
    records.apply({ id: null, state: 'working' })
    records.apply({ id: 'build', state: 'working' })
    records.apply({ id: 'build/test', state: 'working' })
    records.apply({ id: 'builder', state: 'working' })
    expect(records.apply({ id: 'build', state: 'clear' })).toBe(true)
    expect(records.descendants().map((record) => record.id)).toEqual(['builder'])
    expect(records.root()?.state).toBe('working')
    expect(records.apply({ id: null, state: 'clear' })).toBe(true)
    expect(records.root()).toBeUndefined()
    expect(records.descendants()).toEqual([])
  })

  it('drops working, blocked and idle when the program ends but keeps done and error', () => {
    const records = new ProgramStatusRecordSet()
    records.apply({ id: null, state: 'blocked', kind: 'question' })
    records.apply({ id: 'a', state: 'done' })
    records.apply({ id: 'b', state: 'error' })
    records.apply({ id: 'c', state: 'idle' })
    expect(records.endProgram()).toBe(true)
    expect(records.root()).toBeUndefined()
    expect(records.descendants().map((record) => record.id)).toEqual(['a', 'b'])
    expect(records.endProgram()).toBe(false)
  })

  it('evicts the least recently updated record past the cap', () => {
    const records = new ProgramStatusRecordSet()
    records.apply({ id: null, state: 'working' })
    for (let i = 0; i < PROGRAM_STATUS_MAX_RECORDS; i += 1) {
      records.apply({ id: `r${i}`, state: 'working' })
    }
    expect(records.root()).toBeUndefined()
    expect(records.descendants()).toHaveLength(PROGRAM_STATUS_MAX_RECORDS)
    expect(records.descendants()[0].id).toBe('r0')
  })
})
