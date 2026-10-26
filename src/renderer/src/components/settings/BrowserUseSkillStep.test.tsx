import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { BrowserUseSkillStep } from './BrowserUseSkillStep'

const capturedPanel = vi.hoisted(() => ({
  props: null as null | Record<string, unknown>
}))

vi.mock('./AgentSkillSetupPanel', () => ({
  AgentSkillSetupPanel: (props: Record<string, unknown>) => {
    capturedPanel.props = props
    return <div data-testid="browser-use-skill-step" />
  }
}))

describe('BrowserUseSkillStep', () => {
  it('installs the orca-cli skill, which also updates it once installed', () => {
    renderToStaticMarkup(
      <BrowserUseSkillStep
        skillDetected
        skillLoading={false}
        skillError={null}
        onRecheck={vi.fn()}
      />
    )

    expect(capturedPanel.props).toEqual(
      expect.objectContaining({ skillNames: ['orca-cli'], installed: true })
    )
    expect(capturedPanel.props?.installedSkillNames).toBeUndefined()
  })
})
