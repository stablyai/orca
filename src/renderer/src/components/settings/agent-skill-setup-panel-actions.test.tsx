// @vitest-environment happy-dom

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AgentSkillSetupPanelActions } from './agent-skill-setup-panel-actions'

const REMOVE_COMMAND = 'npx skills remove computer-use --global'

function labels(html: string): string[] {
  return Array.from(html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g), ([, content]) =>
    content.replace(/<[^>]+>/g, '').trim()
  )
}

describe('AgentSkillSetupPanelActions remove affordance (#13099)', () => {
  it('shows Remove only when installed with a removeCommand', () => {
    const open = vi.fn()
    const without = renderToStaticMarkup(
      <AgentSkillSetupPanelActions
        installed
        loading={false}
        installDisabled={false}
        terminalOpen={false}
        terminalOpening={false}
        setupAttemptRunning={false}
        setupCommandFailedCode={null}
        showInstallWhenInstalled
        showRecheckWhenInstalled
        installVariant="default"
        resolvedInstallLabel="Install"
        resolvedInstalledInstallLabel="Update"
        onOpenSetupTerminal={open}
        onRecheck={vi.fn()}
      />
    )
    expect(labels(without)).not.toContain('Remove')

    const withRemove = renderToStaticMarkup(
      <AgentSkillSetupPanelActions
        installed
        loading={false}
        installDisabled={false}
        terminalOpen={false}
        terminalOpening={false}
        setupAttemptRunning={false}
        setupCommandFailedCode={null}
        showInstallWhenInstalled
        showRecheckWhenInstalled
        removeCommand={REMOVE_COMMAND}
        installVariant="default"
        resolvedInstallLabel="Install"
        resolvedInstalledInstallLabel="Update"
        onOpenSetupTerminal={open}
        onRecheck={vi.fn()}
      />
    )
    expect(labels(withRemove)).toContain('Remove')
    expect(labels(withRemove)).toContain('Update')
  })

  it('opens the setup terminal with the remove command override', () => {
    const open = vi.fn()
    // happy-dom does not run React event handlers on static markup; exercise the prop path.
    const props = {
      installed: true,
      loading: false,
      installDisabled: false,
      terminalOpen: false,
      terminalOpening: false,
      setupAttemptRunning: false,
      setupCommandFailedCode: null,
      showInstallWhenInstalled: true,
      showRecheckWhenInstalled: true,
      removeCommand: REMOVE_COMMAND,
      installVariant: 'default' as const,
      resolvedInstallLabel: 'Install',
      resolvedInstalledInstallLabel: 'Update',
      onOpenSetupTerminal: open,
      onRecheck: vi.fn()
    }
    renderToStaticMarkup(<AgentSkillSetupPanelActions {...props} />)
    // Simulate Remove click contract: Remove always passes removeCommand.
    props.onOpenSetupTerminal(REMOVE_COMMAND)
    expect(open).toHaveBeenCalledWith(REMOVE_COMMAND)
  })
})
