import { describe, expect, it } from 'vitest'
import { isReservedPluginPublisher } from './plugin-publisher-reservation'

describe('isReservedPluginPublisher', () => {
  it.each([
    'stablyai',
    'StablyAI',
    'orca',
    'orca-labs',
    'Orcatools',
    'openai',
    'GitHub',
    'official'
  ])('reserves %s', (publisher) => {
    expect(isReservedPluginPublisher(publisher)).toBe(true)
  })

  it.each(['acme', 'gleam-community', 'githubber', 'mo-orca', '0rca'])(
    'leaves %s alone',
    (publisher) => {
      expect(isReservedPluginPublisher(publisher)).toBe(false)
    }
  )
})
