import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ORCA_CLI_SKILL_INSTALL_COMMAND } from '@/lib/agent-feature-install-commands'
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
  it('reuses the pinned install command as the update once installed', () => {
    renderToStaticMarkup(
      <BrowserUseSkillStep
        command={ORCA_CLI_SKILL_INSTALL_COMMAND}
        skillDetected
        skillLoading={false}
        skillError={null}
        onRecheck={vi.fn()}
      />
    )

    expect(capturedPanel.props).toEqual(
      expect.objectContaining({ command: ORCA_CLI_SKILL_INSTALL_COMMAND, installed: true })
    )
    expect(capturedPanel.props?.installedCommand).toBeUndefined()
  })
})
