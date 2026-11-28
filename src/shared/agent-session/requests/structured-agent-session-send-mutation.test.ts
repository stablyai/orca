import { describe, expect, it } from 'vitest'
import { structuredAgentSessionSendBody } from './structured-agent-session-send-mutation'

const skill = { name: 'hello-test', path: '/tmp/skills/hello-test/SKILL.md' }

describe('structuredAgentSessionSendBody picked skills', () => {
  it('retains a picked skill still mentioned by /name', () => {
    expect(structuredAgentSessionSendBody('please /hello-test', [], [skill]).skills).toEqual([
      skill
    ])
  })

  it('drops a picked skill whose token is gone', () => {
    expect(structuredAgentSessionSendBody('please', [], [skill]).skills).toBeUndefined()
  })

  it('does not match a path that starts with the skill token', () => {
    expect(
      structuredAgentSessionSendBody('please /hello-test/file.ts', [], [skill]).skills
    ).toBeUndefined()
  })
})
