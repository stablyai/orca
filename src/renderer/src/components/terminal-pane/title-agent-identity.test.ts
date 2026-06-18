import { describe, expect, it } from 'vitest'
import { titleHasExplicitAgentIdentity } from './title-agent-identity'

describe('titleHasExplicitAgentIdentity', () => {
  it('recognizes Devin executable titles through the shared token matcher', () => {
    expect(titleHasExplicitAgentIdentity('devin.exe ready')).toBe(true)
    expect(titleHasExplicitAgentIdentity('devin.cmd working')).toBe(true)
  })

  it('rejects Devin path and compound fragments', () => {
    expect(titleHasExplicitAgentIdentity('C:\\work\\devin.exe\\ready')).toBe(false)
    expect(titleHasExplicitAgentIdentity('devin-fixtures ready')).toBe(false)
  })
})
