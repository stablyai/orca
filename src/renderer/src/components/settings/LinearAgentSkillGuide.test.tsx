import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LinearAgentSkillGuide, type LinearSetupReadiness } from './LinearAgentSkillGuide'

const baseReadiness: LinearSetupReadiness = {
  connected: true,
  checking: false,
  skillInstalled: false,
  skillChecking: false,
  skillUnverifiable: false,
  visible: true
}

function renderGuide(readiness: Partial<LinearSetupReadiness>): string {
  return renderToStaticMarkup(
    <LinearAgentSkillGuide
      readiness={{ ...baseReadiness, ...readiness }}
      onOpenTaskSources={vi.fn()}
      onManageLinearAccess={vi.fn()}
      skillPanel={<div data-testid="skill-panel">Skill install panel</div>}
    />
  )
}

describe('LinearAgentSkillGuide', () => {
  it('renders the setup checklist with an inlined skill panel', () => {
    const markup = renderGuide({})

    expect(markup).toContain('Setup checklist')
    expect(markup).toContain('2 of 3 ready')
    expect(markup).toContain('Task Sources')
    expect(markup).toContain('Skill install panel')
    expect(markup).not.toContain('Ready below')
    expect(markup).not.toContain('Install below')
    expect(markup).not.toContain('Agent skill')
    expect(markup).not.toContain('Open Task Sources setup')
  })

  it('marks the checklist complete when every step is done', () => {
    expect(renderGuide({ skillInstalled: true })).toContain('All set')
  })

  it('keeps durable progress while a skill recheck is in flight', () => {
    const markup = renderGuide({ skillInstalled: true, skillChecking: true })

    expect(markup).toContain('Checking…')
    expect(markup).not.toContain('2 of 3 ready')
    expect(markup).not.toContain('All set')
  })

  it('keeps durable progress while a connection check is in flight', () => {
    const markup = renderGuide({ skillInstalled: true, checking: true })

    expect(markup).toContain('Checking…')
    expect(markup).not.toContain('2 of 3 ready')
  })

  // The reported bug: a scan that could not vouch for "not installed" was counted
  // as a step the user had left undone.
  it('reports an unverifiable skill scan as unknown instead of an unfinished step', () => {
    const markup = renderGuide({ skillUnverifiable: true })

    expect(markup).toContain('Cannot verify')
    expect(markup).toContain('2/3')
    expect(markup).toContain('bg-amber-500')
    expect(markup).not.toContain('2 of 3 ready')
    expect(markup).not.toContain('All set')
  })

  it('still claims nothing while a rescan of an unverifiable step runs', () => {
    const markup = renderGuide({ skillUnverifiable: true, skillChecking: true })

    expect(markup).toContain('Checking…')
    expect(markup).not.toContain('Cannot verify')
  })

  it('lets a found skill outrank a stale unverifiable flag', () => {
    const markup = renderGuide({ skillInstalled: true, skillUnverifiable: true })

    expect(markup).toContain('All set')
    expect(markup).not.toContain('Cannot verify')
  })

  // The unknown-skill label is only the headline when the skill is the sole open
  // question; a plainly unfinished step must still read as the count.
  it('keeps the confirmed count when the unfinished step is the connection', () => {
    const markup = renderGuide({ connected: false, skillUnverifiable: true })

    expect(markup).toContain('1 of 3 ready')
    expect(markup).not.toContain('Cannot verify')
  })

  it('does not headline an unknown skill over an unfinished visibility step', () => {
    const markup = renderGuide({ visible: false, skillUnverifiable: true })

    expect(markup).toContain('1 of 3 ready')
    expect(markup).not.toContain('Cannot verify')
    // Hiding Linear is deliberate, so the shared table keeps this pill neutral.
    expect(markup).not.toContain('bg-amber-500')
  })
})
