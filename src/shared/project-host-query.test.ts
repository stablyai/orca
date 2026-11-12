import { describe, expect, it } from 'vitest'
import { matchProjectHostQuery } from './project-host-query'

const orca = {
  name: 'orca',
  detail: 'stablyai/orca',
  hostLabels: ['Local', 'build-box', 'mac-mini']
}

describe('matchProjectHostQuery', () => {
  it('keeps every host when the query names only the project', () => {
    expect(matchProjectHostQuery('orc', orca)).toEqual({ hostIndexes: null })
    expect(matchProjectHostQuery('stablyai', orca)).toEqual({ hostIndexes: null })
    expect(matchProjectHostQuery('orca stablyai', orca)).toEqual({ hostIndexes: null })
  })

  it('narrows to the named host when host and project are typed together', () => {
    expect(matchProjectHostQuery('build orca', orca)).toEqual({ hostIndexes: [1] })
    expect(matchProjectHostQuery('orca mac', orca)).toEqual({ hostIndexes: [2] })
  })

  it('narrows by a host word that the project detail also contains', () => {
    const buildOrca = { ...orca, detail: 'build/orca' }
    expect(matchProjectHostQuery('build orca', buildOrca)).toEqual({ hostIndexes: [1] })
    expect(matchProjectHostQuery('build', buildOrca)).toEqual({ hostIndexes: null })
  })

  it('lists the project on a host when only the host is typed', () => {
    expect(matchProjectHostQuery('mini', orca)).toEqual({ hostIndexes: [2] })
  })

  it('drops the project when a word matches neither it nor any host', () => {
    expect(matchProjectHostQuery('build docs', orca)).toBeNull()
    expect(matchProjectHostQuery('nowhere', orca)).toBeNull()
  })
})
