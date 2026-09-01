// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_CATALOG, AgentIcon, type AgentCatalogEntry } from '@/lib/agent-catalog'
import { AGENT_FAVICON_ASSETS } from '@/lib/agent-favicon-assets'
import type { TuiAgent } from '../../../../shared/types'
import AgentCombobox from './AgentCombobox'

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
    const claudeRow = screen.getByRole('option', { name: 'Claude' }).firstElementChild
    fireEvent.contextMenu(claudeRow as HTMLElement)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Set as default' }))

    expect(onSetDefault).toHaveBeenCalledWith('claude')
  })
})

function entry(id: TuiAgent, label: string): AgentCatalogEntry {
  return { id, label, cmd: String(id), homepageUrl: 'https://example.com' }
}

const AGENTS: AgentCatalogEntry[] = [
  entry('codex', 'Codex'),
  entry('claude', 'Claude'),
  entry('copilot', 'GitHub Copilot')
]

// happy-dom reports zero layout, so @tanstack/react-virtual would window nothing
// and rows would never mount. Feed the listbox a real viewport height and each
// option row its estimate so rows mount and the mounted-DOM bound is exercised.
function isOptionElement(el: HTMLElement): boolean {
  return typeof el.getAttribute === 'function' && el.getAttribute('role') === 'option'
}

let restore: (() => void) | undefined
beforeEach(() => {
  const rect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
    const height = isOptionElement(this) ? 34 : 500
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 400,
      bottom: height,
      width: 400,
      height,
      toJSON() {}
    }
  }
  const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
  const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isOptionElement(this) ? 34 : 500
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 400
  })
  restore = () => {
    HTMLElement.prototype.getBoundingClientRect = rect
    if (offsetHeight) {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight)
    }
    if (offsetWidth) {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth)
    }
  }
})

afterEach(() => {
  restore?.()
  cleanup()
})

describe('AgentCombobox trigger markup', () => {
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

describe('AgentCombobox interaction', () => {
  it('selects an agent from the open list', () => {
    const onValueChange = vi.fn()
    render(<AgentCombobox agents={AGENTS} value={null} onValueChange={onValueChange} />)
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByText('Codex'))
    expect(onValueChange).toHaveBeenCalledWith('codex')
  })

  it('selects the Blank Terminal sentinel back to null', () => {
    const onValueChange = vi.fn()
    render(<AgentCombobox agents={AGENTS} value="codex" onValueChange={onValueChange} />)
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByText('Blank Terminal'))
    expect(onValueChange).toHaveBeenCalledWith(null)
  })

  it('opens and seeds the query from a printable keydown on the closed trigger', () => {
    render(<AgentCombobox agents={AGENTS} value={null} onValueChange={vi.fn()} />)
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'c' })
    const input = screen.getByPlaceholderText('Search agents...') as HTMLInputElement
    expect(input.value).toBe('c')
    expect(screen.getByText('Codex')).toBeTruthy()
  })

  it('opens on ArrowDown from the closed trigger without seeding a query', () => {
    render(<AgentCombobox agents={AGENTS} value={null} onValueChange={vi.fn()} />)
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' })
    const input = screen.getByPlaceholderText('Search agents...') as HTMLInputElement
    expect(input.value).toBe('')
    expect(screen.getByRole('listbox')).toBeTruthy()
  })

  it('runs onTriggerEnter on Enter at the closed trigger instead of opening', () => {
    const onTriggerEnter = vi.fn()
    render(
      <AgentCombobox
        agents={AGENTS}
        value="codex"
        onValueChange={vi.fn()}
        onTriggerEnter={onTriggerEnter}
      />
    )
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
    expect(onTriggerEnter).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('invokes the Manage agents footer action', () => {
    const onOpenManageAgents = vi.fn()
    render(
      <AgentCombobox
        agents={AGENTS}
        value={null}
        onValueChange={vi.fn()}
        onOpenManageAgents={onOpenManageAgents}
      />
    )
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByText('Manage agents'))
    expect(onOpenManageAgents).toHaveBeenCalledTimes(1)
  })

  it('clears the highlight on footer hover instead of snapping it to the first row', () => {
    render(
      <AgentCombobox
        agents={AGENTS}
        value="claude"
        onValueChange={vi.fn()}
        onOpenManageAgents={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('combobox'))
    const input = screen.getByPlaceholderText('Search agents...')
    expect(input.getAttribute('aria-activedescendant')).toBeTruthy()

    // React synthesizes onMouseEnter from mouseover, so mouseOver is the hover event here.
    fireEvent.mouseOver(screen.getByText('Manage agents'))
    expect(document.querySelector('[role="option"][aria-selected="true"]')).toBeNull()
    expect(input.getAttribute('aria-activedescendant')).toBeNull()
  })

  it('keeps arrow navigation working after the footer clears the highlight', () => {
    const onValueChange = vi.fn()
    render(
      <AgentCombobox
        agents={AGENTS}
        value="claude"
        onValueChange={onValueChange}
        onOpenManageAgents={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.mouseOver(screen.getByText('Manage agents'))

    const input = screen.getByPlaceholderText('Search agents...')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    // Blank Terminal is the first row when a blank selection is allowed.
    expect(onValueChange).toHaveBeenCalledWith(null)
  })

  it('re-highlights the top match when typing after a footer hover', () => {
    render(
      <AgentCombobox
        agents={AGENTS}
        value="claude"
        onValueChange={vi.fn()}
        onOpenManageAgents={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.mouseOver(screen.getByText('Manage agents'))

    const input = screen.getByPlaceholderText('Search agents...')
    fireEvent.change(input, { target: { value: 'cod' } })
    expect(document.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain(
      'Codex'
    )
  })

  it('sets a default from the right-click menu', () => {
    const onSetDefault = vi.fn()
    render(
      <AgentCombobox
        agents={AGENTS}
        value={null}
        onValueChange={vi.fn()}
        defaultAgent="blank"
        onSetDefault={onSetDefault}
      />
    )
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.contextMenu(screen.getByText('Codex'))
    fireEvent.click(screen.getByText('Set as default'))
    expect(onSetDefault).toHaveBeenCalledWith('codex')
  })

  it('navigates the open list with the arrow keys and selects with Enter', () => {
    const onValueChange = vi.fn()
    render(<AgentCombobox agents={AGENTS} value={null} onValueChange={onValueChange} />)
    fireEvent.click(screen.getByRole('combobox'))
    // Opens on Blank (value is null); step down to the first agent.
    const input = screen.getByPlaceholderText('Search agents...')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onValueChange).toHaveBeenCalledWith('codex')
  })

  it('wires listbox/option aria and tracks the active row via aria-activedescendant', () => {
    render(<AgentCombobox agents={AGENTS} value="codex" onValueChange={vi.fn()} />)
    const trigger = screen.getByRole('combobox')
    const listboxId = trigger.getAttribute('aria-controls')
    expect(listboxId).toBeTruthy()

    fireEvent.click(trigger)
    expect(document.getElementById(listboxId as string)?.getAttribute('role')).toBe('listbox')

    const input = screen.getByPlaceholderText('Search agents...')
    const activeOption = document.querySelector('[role="option"][aria-selected="true"]')
    expect(activeOption?.textContent).toContain('Codex')
    expect(input.getAttribute('aria-activedescendant')).toBe(activeOption?.id)
  })

  it('mounts a bounded row set and still reaches the last row via keyboard at 1,000 agents', () => {
    const many: AgentCatalogEntry[] = Array.from({ length: 1000 }, (_, i) =>
      entry(`custom-agent:codex:${i}` as TuiAgent, `Agent ${i}`)
    )
    const onValueChange = vi.fn()
    render(<AgentCombobox agents={many} value={null} onValueChange={onValueChange} />)
    fireEvent.click(screen.getByRole('combobox'))

    const mounted = document.querySelectorAll('[role="option"]')
    expect(mounted.length).toBeGreaterThan(0)
    expect(mounted.length).toBeLessThanOrEqual(60)

    const input = screen.getByPlaceholderText('Search agents...')
    fireEvent.keyDown(input, { key: 'End' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onValueChange).toHaveBeenCalledWith('custom-agent:codex:999')
  })
})

describe('AgentCombobox stale reference (F3)', () => {
  it('shows a repair warning instead of silently rebinding a missing value to Blank', () => {
    render(
      <AgentCombobox
        agents={AGENTS}
        value={'custom-agent:codex:gone' as TuiAgent}
        onValueChange={vi.fn()}
      />
    )
    const trigger = screen.getByRole('combobox')
    expect(trigger.textContent).not.toContain('Blank Terminal')
    expect(trigger.textContent).toContain('Unavailable agent')
    expect(screen.getByText(/this agent is unavailable/i)).toBeTruthy()
  })

  it('shows the supplied stale label and icon when provided', () => {
    render(
      <AgentCombobox
        agents={AGENTS}
        value={'custom-agent:codex:gone' as TuiAgent}
        onValueChange={vi.fn()}
        staleAgent={{ label: 'Removed Agent', baseAgent: 'codex' }}
      />
    )
    expect(screen.getByRole('combobox').textContent).toContain('Removed Agent')
  })

  it('renders the resolved agent with no warning when the value is available', () => {
    render(<AgentCombobox agents={AGENTS} value="codex" onValueChange={vi.fn()} />)
    const trigger = screen.getByRole('combobox')
    expect(trigger.textContent).toContain('Codex')
    expect(screen.queryByText(/this agent is unavailable/i)).toBeNull()
  })
})

describe('AgentCombobox custom-agent base icon', () => {
  const CUSTOM_ID = 'custom-agent:codex:abc' as TuiAgent
  function customEntry(baseAgent: AgentCatalogEntry['baseAgent']): AgentCatalogEntry {
    return {
      id: CUSTOM_ID,
      label: 'My Codex',
      cmd: 'codex',
      homepageUrl: 'https://example.com',
      baseAgent
    }
  }

  it('shows the base harness icon (not the letter fallback) and the human label for a selected custom', () => {
    const codexIcon = renderToStaticMarkup(<AgentIcon agent="codex" />)
    const withBase = renderToStaticMarkup(
      <AgentCombobox agents={[customEntry('codex')]} value={CUSTOM_ID} onValueChange={vi.fn()} />
    )
    const withoutBase = renderToStaticMarkup(
      <AgentCombobox agents={[customEntry(undefined)]} value={CUSTOM_ID} onValueChange={vi.fn()} />
    )
    // baseAgent routes the icon to the real Codex harness mark...
    expect(withBase).toContain(codexIcon)
    // ...where the bare custom id would otherwise fall to a letter glyph.
    expect(withoutBase).not.toContain(codexIcon)
    // The row shows the human label, never the raw custom-agent id.
    expect(withBase).toContain('My Codex')
    expect(withBase).not.toContain(CUSTOM_ID)
  })

  it('renders the base icon on the open custom-agent row', () => {
    render(
      <AgentCombobox
        agents={[customEntry('codex'), entry('claude', 'Claude')]}
        value={null}
        onValueChange={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('combobox'))
    const row = screen.getByText('My Codex').closest('[role="option"]') as HTMLElement
    // The base (codex) mark has no <text> glyph; the letter fallback would render one.
    expect(row.querySelector('text')).toBeNull()
    expect(row.textContent).not.toContain(CUSTOM_ID)
  })
})
