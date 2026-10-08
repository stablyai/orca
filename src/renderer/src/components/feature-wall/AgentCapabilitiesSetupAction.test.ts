import { describe, expect, it } from 'vitest'
import {
  getDefaultAgentCapabilitySetupSelection,
  isAgentCapabilityReadinessComplete
} from './agent-capability-setup-status'

const READY_INPUT = {
  browserUseSkillInstalled: true,
  browserUseSkillLoading: false,
  computerUseSkillInstalled: true,
  computerUseSkillLoading: false,
  computerUseReady: true,
  computerUseChecking: false,
  computerUseUnavailable: false,
  orchestrationSkillInstalled: true,
  orchestrationSkillLoading: false
}

describe('getDefaultAgentCapabilitySetupSelection', () => {
  it('leaves already-ready capabilities unchecked by default', () => {
    expect(getDefaultAgentCapabilitySetupSelection(READY_INPUT)).toEqual({
      browserUse: false,
      computerUse: false,
      orchestration: false,
      linearTickets: false
    })
  })

  it('keeps missing skills selected by default', () => {
    expect(
      getDefaultAgentCapabilitySetupSelection({
        ...READY_INPUT,
        browserUseSkillInstalled: false,
        orchestrationSkillInstalled: false
      })
    ).toEqual({
      browserUse: true,
      computerUse: false,
      orchestration: true,
      linearTickets: false
    })
  })

  it('keeps Computer Use selected when permissions still need setup', () => {
    expect(
      getDefaultAgentCapabilitySetupSelection({
        ...READY_INPUT,
        computerUseReady: false
      })
    ).toEqual({
      browserUse: false,
      computerUse: true,
      orchestration: false,
      linearTickets: false
    })
  })

  it('leaves Computer Use unchecked when this build cannot enable it', () => {
    expect(
      getDefaultAgentCapabilitySetupSelection({
        ...READY_INPUT,
        computerUseReady: false,
        computerUseUnavailable: true
      })
    ).toEqual({
      browserUse: false,
      computerUse: false,
      orchestration: false,
      linearTickets: false
    })
  })
})

describe('isAgentCapabilityReadinessComplete', () => {
  it('is complete when every skill is ready, or Computer Use cannot run here', () => {
    expect(isAgentCapabilityReadinessComplete(READY_INPUT)).toBe(true)
    expect(
      isAgentCapabilityReadinessComplete({
        ...READY_INPUT,
        computerUseReady: false,
        computerUseUnavailable: true
      })
    ).toBe(true)
  })

  it('is incomplete while Computer Use still needs macOS access or a skill is missing', () => {
    expect(isAgentCapabilityReadinessComplete({ ...READY_INPUT, computerUseReady: false })).toBe(
      false
    )
    expect(
      isAgentCapabilityReadinessComplete({ ...READY_INPUT, orchestrationSkillInstalled: false })
    ).toBe(false)
  })

  it('does not claim completion while install probes are still running', () => {
    expect(
      isAgentCapabilityReadinessComplete({ ...READY_INPUT, browserUseSkillLoading: true })
    ).toBe(false)
  })
})
