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
  it('forwards a single-skill installed command even when setup installs a bundle', () => {
    const bundleInstallCommand =
      'npx skills add https://github.com/stablyai/orca --skill orca-cli orchestration --global'
    const updateCommand = 'npx skills update orca-cli --global'

    renderToStaticMarkup(
      <BrowserUseSkillStep
        command={bundleInstallCommand}
        installedCommand={updateCommand}
        skillDetected
        skillLoading={false}
        skillError={null}
        onRecheck={vi.fn()}
      />
    )

    expect(capturedPanel.props).toEqual(
      expect.objectContaining({
        command: bundleInstallCommand,
        installedCommand: updateCommand,
        installed: true
      })
    )
  })
})
