// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { AGENT_CATALOG, AgentIcon } from '@/lib/agent-catalog'
import { AGENT_FAVICON_ASSETS } from '@/lib/agent-favicon-assets'
import AgentCombobox from './AgentCombobox'

afterEach(cleanup)

describe('AgentCombobox', () => {
  it('sets the closed trigger selection as the default agent', () => {
    const onSetDefault = vi.fn()
    render(
      <AgentCombobox
        agents={AGENT_CATALOG}
        value="codex"
        onValueChange={vi.fn()}
        defaultAgent="claude"
        onSetDefault={onSetDefault}
      />
    )

    const trigger = screen.getByRole('combobox')
    fireEvent.contextMenu(trigger)

    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Set as default' }))
    expect(onSetDefault).toHaveBeenCalledWith('codex')
  })

  it('maps the closed Blank Terminal selection to the blank default preference', () => {
    const onSetDefault = vi.fn()
    render(
      <AgentCombobox
        agents={AGENT_CATALOG}
        value={null}
        onValueChange={vi.fn()}
        defaultAgent="codex"
        onSetDefault={onSetDefault}
      />
    )

    fireEvent.contextMenu(screen.getByRole('combobox'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Set as default' }))

    expect(onSetDefault).toHaveBeenCalledWith('blank')
  })

  it('does not offer a default action for an Agent-only empty state', () => {
    const onSetDefault = vi.fn()
    render(
      <AgentCombobox
        agents={[]}
        value={null}
        onValueChange={vi.fn()}
        allowBlankTerminal={false}
        emptyLabel="Select an Agent"
        onSetDefault={onSetDefault}
      />
    )

    fireEvent.contextMenu(screen.getByRole('combobox'))

    expect(screen.queryByRole('menuitem')).toBeNull()
    expect(onSetDefault).not.toHaveBeenCalled()
  })

  it('marks the closed trigger when its selection is already the default', () => {
    const onSetDefault = vi.fn()
    render(
      <AgentCombobox
        agents={AGENT_CATALOG}
        value="codex"
        onValueChange={vi.fn()}
        defaultAgent="codex"
        onSetDefault={onSetDefault}
      />
    )

    fireEvent.contextMenu(screen.getByRole('combobox'))
    const menuItem = screen.getByRole('menuitem', { name: 'Current default' })

    expect(menuItem.hasAttribute('data-disabled')).toBe(true)
    fireEvent.click(menuItem)
    expect(onSetDefault).not.toHaveBeenCalled()
  })

  it('keeps the expanded agent-row default action available', () => {
    const onSetDefault = vi.fn()
    render(
      <AgentCombobox
        agents={AGENT_CATALOG}
        value="codex"
        onValueChange={vi.fn()}
        defaultAgent="codex"
        onSetDefault={onSetDefault}
      />
    )

    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.contextMenu(screen.getByRole('option', { name: 'Claude' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Set as default' }))

    expect(onSetDefault).toHaveBeenCalledWith('claude')
  })

  it('keeps enough trigger width for GitHub Copilot when callers pass min-w-0', () => {
    const markup = renderToStaticMarkup(
      <AgentCombobox
        agents={AGENT_CATALOG}
        value="copilot"
        onValueChange={vi.fn()}
        triggerClassName="h-9 w-full min-w-0"
      />
    )

    expect(markup).toContain('GitHub Copilot')
    expect(markup).toContain('!min-w-[260px]')
    expect(markup).toContain('flex-1')
  })

  it('centers the selected agent mark and label inside a full-width form trigger', () => {
    const markup = renderToStaticMarkup(
      <AgentCombobox
        agents={AGENT_CATALOG}
        value="codex"
        onValueChange={vi.fn()}
        allowNarrowTrigger
        triggerClassName="h-9 w-full min-w-0"
      />
    )

    expect(markup).toContain('Codex')
    expect(markup).not.toContain('!min-w-[260px]')
    expect(markup).toContain('min-w-0 w-full')
    expect(markup).toContain('leading-none')
    expect(markup).toContain('size-3.5 shrink-0')
    expect(markup).not.toContain('translate-y')
    // Why: React HTML-escapes `[`/`&` in class strings during static markup.
    expect(markup).toContain('size-3.5!')
  })

  it('uses the same centered 14px layout for every agent mark', () => {
    for (const agent of AGENT_CATALOG) {
      const markup = renderToStaticMarkup(
        <AgentCombobox
          agents={AGENT_CATALOG}
          value={agent.id}
          onValueChange={vi.fn()}
          allowNarrowTrigger
        />
      )

      expect(markup).toContain(agent.label)
      expect(markup).toContain('size-3.5 shrink-0')
      expect(markup).not.toContain('translate-y')
      expect(markup).toContain('width="14"')
      expect(markup).toContain('height="14"')
    }
  })

  it('supports an Agent-only empty state without presenting a blank terminal', () => {
    const markup = renderToStaticMarkup(
      <AgentCombobox
        agents={[]}
        value={null}
        onValueChange={vi.fn()}
        allowBlankTerminal={false}
        emptyLabel="Select an Agent"
      />
    )

    expect(markup).toContain('Select an Agent')
    expect(markup).not.toContain('Blank Terminal')
  })

  it('uses the bundled OpenClaude favicon crop instead of Claude or GitHub artwork', () => {
    const markup = renderToStaticMarkup(<AgentIcon agent="openclaude" />)

    expect(markup).toContain('/resources/openclaude-logo.png')
    expect(markup).toContain('<img')
    expect(markup).not.toContain('https://github.com/Gitlawb.png')
    expect(markup).not.toContain('<svg')
  })

  it('uses the official OpenCode SVG mark instead of a remote favicon', () => {
    const markup = renderToStaticMarkup(<AgentIcon agent="opencode" />)

    expect(markup).toContain('<svg')
    expect(markup).toContain('viewBox="0 0 512 512"')
    expect(markup).not.toContain('/resources/opencode.webp')
    expect(markup).not.toContain('https://www.google.com/s2/favicons')
    expect(markup).not.toContain('<img')
  })

  it('renders bundled favicons for favicon-domain agents instead of the remote Google service', () => {
    // Why: previously loaded from Google's favicon service (#8451). Iterate the
    // full asset map so missing files/key mismatches fail the test.
    for (const agent of Object.keys(AGENT_FAVICON_ASSETS) as TuiAgent[]) {
      const markup = renderToStaticMarkup(<AgentIcon agent={agent} />)
      expect(markup).toContain(`/shared/agent-icons/${agent}.png`)
      expect(markup).not.toContain('https://www.google.com/s2/favicons')
    }
  })
})
