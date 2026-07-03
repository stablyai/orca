import { afterEach, describe, expect, it } from 'vitest'
import {
  forgetAgentHibernationPaneOutput,
  forgetAgentHibernationTabOutput,
  getAgentHibernationPaneOutputEpoch,
  recordAgentHibernationPaneOutput,
  resetAgentHibernationOutputActivityForTests
} from './agent-hibernation-output-activity'

const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'

afterEach(() => {
  resetAgentHibernationOutputActivityForTests()
})

describe('agent hibernation output activity', () => {
  it('forgets a single pane epoch so a reopened pane starts fresh at 0', () => {
    const paneKey = `tab-1:${UUID_A}`
    recordAgentHibernationPaneOutput(paneKey)
    recordAgentHibernationPaneOutput(paneKey)
    expect(getAgentHibernationPaneOutputEpoch(paneKey)).toBe(2)

    forgetAgentHibernationPaneOutput(paneKey)

    // Why: a forgotten entry must read back as never-seen (epoch 0) — identical
    // to a brand-new pane — so dropping it on close cannot change behavior.
    expect(getAgentHibernationPaneOutputEpoch(paneKey)).toBe(0)
  })

  it('forgets every pane under a closed tab without touching other tabs', () => {
    const closingTabPaneA = `tab-1:${UUID_A}`
    const closingTabPaneB = `tab-1:${UUID_B}`
    const survivingTabPane = `tab-2:${UUID_A}`
    recordAgentHibernationPaneOutput(closingTabPaneA)
    recordAgentHibernationPaneOutput(closingTabPaneB)
    recordAgentHibernationPaneOutput(survivingTabPane)

    forgetAgentHibernationTabOutput('tab-1')

    expect(getAgentHibernationPaneOutputEpoch(closingTabPaneA)).toBe(0)
    expect(getAgentHibernationPaneOutputEpoch(closingTabPaneB)).toBe(0)
    expect(getAgentHibernationPaneOutputEpoch(survivingTabPane)).toBe(1)
  })

  it('does not match tab ids by mere prefix overlap', () => {
    // Why: forgetting "tab-1" must not also evict "tab-10"; the separator guards
    // against a substring false positive.
    const tab1Pane = `tab-1:${UUID_A}`
    const tab10Pane = `tab-10:${UUID_A}`
    recordAgentHibernationPaneOutput(tab1Pane)
    recordAgentHibernationPaneOutput(tab10Pane)

    forgetAgentHibernationTabOutput('tab-1')

    expect(getAgentHibernationPaneOutputEpoch(tab1Pane)).toBe(0)
    expect(getAgentHibernationPaneOutputEpoch(tab10Pane)).toBe(1)
  })
})
