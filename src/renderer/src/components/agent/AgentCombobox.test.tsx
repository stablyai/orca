// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { AGENT_CATALOG, AgentIcon } from '@/lib/agent-catalog'
import { AGENT_FAVICON_ASSETS } from '@/lib/agent-favicon-assets'
import AgentCombobox from './AgentCombobox'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ReactElement } from 'react'

function renderPicker(element: ReactElement) {
  return render(element, { wrapper: TooltipProvider })
}

afterEach(cleanup)

describe('AgentCombobox', () => {
  it.each(['codex', null] as const)(
    'clears %s without opening the picker or changing defaults',
    (value) => {
      const onClear = vi.fn()
      const onSetDefault = vi.fn()
      const onValueChange = vi.fn()
      renderPicker(
        <AgentCombobox
          agents={AGENT_CATALOG}
          value={value}
          onValueChange={onValueChange}
          allowBlankTerminal
          onSetDefault={onSetDefault}
          clearSelection={{ cleared: false, onClear }}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: 'Clear agent selection' }))
      expect(onClear).toHaveBeenCalledOnce()
      expect(onValueChange).not.toHaveBeenCalled()
      expect(onSetDefault).not.toHaveBeenCalled()
      expect(screen.getByRole('combobox').getAttribute('aria-expanded')).toBe('false')
      expect(document.activeElement).toBe(screen.getByRole('combobox'))
    }
  )

  it('keeps the cleared choice empty and lets the user choose an agent again', () => {
    const onValueChange = vi.fn()
    renderPicker(
      <AgentCombobox
        agents={AGENT_CATALOG}
        value={null}
        onValueChange={onValueChange}
        allowBlankTerminal
        onSetDefault={vi.fn()}
        clearSelection={{ cleared: true, onClear: vi.fn() }}
      />
    )
    expect(screen.getByRole('combobox').textContent).toBe('Select an Agent')
    expect(screen.queryByRole('button', { name: 'Clear agent selection' })).toBeNull()
    fireEvent.contextMenu(screen.getByRole('combobox'))
    expect(screen.queryByRole('menuitem')).toBeNull()
    fireEvent.click(screen.getByRole('combobox'))
    expect(screen.queryByRole('option', { name: 'None' })).toBeNull()
    fireEvent.click(screen.getByRole('option', { name: 'Claude' }))
    expect(onValueChange).toHaveBeenCalledWith('claude')
  })

  it('sets the closed trigger selection as the default agent', () => {
    const onSetDefault = vi.fn()
    renderPicker(
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
    renderPicker(
      <AgentCombobox
        agents={AGENT_CATALOG}
        value={null}
        onValueChange={vi.fn()}
        allowBlankTerminal
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
    renderPicker(
      <AgentCombobox agents={[]} value={null} onValueChange={vi.fn()} onSetDefault={onSetDefault} />
    )

    fireEvent.contextMenu(screen.getByRole('combobox'))

    expect(screen.queryByRole('menuitem')).toBeNull()
    expect(onSetDefault).not.toHaveBeenCalled()
  })

  it('marks the closed trigger when its selection is already the default', () => {
    const onSetDefault = vi.fn()
    renderPicker(
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
    renderPicker(
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

  it('defaults to an Agent-only empty state without presenting a blank terminal', () => {
    const markup = renderToStaticMarkup(
      <AgentCombobox agents={[]} value={null} onValueChange={vi.fn()} />
    )

    expect(markup).toContain('Select an Agent')
    expect(markup).not.toContain('Blank Terminal')
  })

  it('hides Blank Terminal from the list unless the caller opts in', () => {
    renderPicker(<AgentCombobox agents={AGENT_CATALOG} value="codex" onValueChange={vi.fn()} />)

    fireEvent.click(screen.getByRole('combobox'))

    expect(screen.getByRole('option', { name: 'Claude' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Blank Terminal' })).toBeNull()
  })

  it('offers Blank Terminal and reports null when the caller opts in', () => {
    const onValueChange = vi.fn()
    renderPicker(
      <AgentCombobox
        agents={AGENT_CATALOG}
        value="codex"
        onValueChange={onValueChange}
        allowBlankTerminal
      />
    )

    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByRole('option', { name: 'Blank Terminal' }))

    expect(onValueChange).toHaveBeenCalledWith(null)
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

  it('uses the bundled DeepSeek whale for observed DeepSeek Build sessions without adding it to the launch catalog', () => {
    const markup = renderToStaticMarkup(<AgentIcon agent="dsb" />)

    expect(markup).toContain(AGENT_FAVICON_ASSETS.dsh)
    expect(AGENT_CATALOG.map((agent) => agent.id)).not.toContain('dsb')
  })

  it('renders bundled favicons for favicon-domain agents instead of the remote Google service', () => {
    // Why: previously loaded from Google's favicon service (#8451). Iterate the
    // full asset map so missing files/key mismatches fail the test.
    const sharedIcons = new Map([['qoder-cn', 'qoder']])
    for (const agent of Object.keys(AGENT_FAVICON_ASSETS) as TuiAgent[]) {
      const markup = renderToStaticMarkup(<AgentIcon agent={agent} />)
      const iconName = sharedIcons.get(agent) ?? agent
      expect(markup).toContain(`/shared/agent-icons/${iconName}.png`)
      expect(markup).not.toContain('https://www.google.com/s2/favicons')
    }
  })
})
