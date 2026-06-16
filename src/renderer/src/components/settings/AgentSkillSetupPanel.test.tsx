import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'

function renderPanel(overrides: Partial<ComponentProps<typeof AgentSkillSetupPanel>> = {}): string {
  return renderToStaticMarkup(
    <AgentSkillSetupPanel
      title="CLI skill"
      description="Enables agents to use Orca workflows."
      command="npx skills add https://github.com/stablyai/orca --skill orca-cli --global"
      terminalTitle="CLI skill setup"
      terminalAriaLabel="CLI skill install terminal"
      terminalWorktreeId="settings-cli-skill-terminal"
      installed={false}
      loading={false}
      error={null}
      onRecheck={vi.fn()}
      {...overrides}
    />
  )
}

function buttonLabels(html: string): string[] {
  return Array.from(html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g), ([, content]) =>
    content
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

function buttonMarkupByLabel(html: string, label: string): string | undefined {
  return Array.from(html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g), ([button]) => button).find(
    (button) => buttonLabels(button).includes(label)
  )
}

describe('AgentSkillSetupPanel', () => {
  it('keeps the install action visible after the skill is detected', () => {
    const html = renderPanel({ installed: true })

    expect(html).toContain('Installed')
    expect(buttonLabels(html)).toContain('Update')
    expect(buttonLabels(html)).toContain('Re-check')
  })

  it('hides only re-check when installed re-checks are disabled', () => {
    const html = renderPanel({ installed: true, showRecheckWhenInstalled: false })

    expect(html).toContain('Installed')
    expect(buttonLabels(html)).toContain('Update')
    expect(buttonLabels(html)).not.toContain('Re-check')
  })

  it('keeps update copy until the installed panel checks CLI prerequisites', () => {
    const html = renderPanel({
      installed: true,
      installLabel: 'Install CLI & Skill',
      preInstallNotice: 'Install the Orca CLI before running agent skill setup.'
    })

    expect(html).toContain('Installed')
    expect(buttonLabels(html)).toContain('Update')
    expect(buttonLabels(html)).not.toContain('Install CLI &amp; Skill')
  })

  it('can hide install after the skill is detected', () => {
    const html = renderPanel({ installed: true, showInstallWhenInstalled: false })

    expect(html).toContain('Installed')
    expect(buttonLabels(html)).not.toContain('Install')
    expect(buttonLabels(html)).toContain('Re-check')
  })

  it('keeps re-check visible before install when installed re-checks are disabled', () => {
    const html = renderPanel({ installed: false, showRecheckWhenInstalled: false })

    expect(buttonLabels(html)).toContain('Install')
    expect(buttonLabels(html)).toContain('Re-check')
  })

  it('keeps install visible but disabled when parent setup is disabled', () => {
    const html = renderPanel({ installDisabled: true })

    expect(buttonMarkupByLabel(html, 'Install')).toContain('disabled=""')
  })
})
