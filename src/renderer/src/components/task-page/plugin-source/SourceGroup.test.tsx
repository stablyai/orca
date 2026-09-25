// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { ContributedPluginTaskSource } from '@/store/slices/plugin-task-sources-slice-contract'
import { TaskPagePluginSourceGroup } from './SourceGroup'

afterEach(cleanup)

const BOARDS: ContributedPluginTaskSource = {
  pluginKey: 'orca-samples.issues',
  sourceId: 'boards',
  title: 'Boards'
}
const SPRINTS: ContributedPluginTaskSource = {
  pluginKey: 'orca-samples.issues',
  sourceId: 'sprints',
  title: 'Sprints'
}

describe('TaskPage contributed source group', () => {
  it('renders nothing when no plugin contributes a source', () => {
    const { container } = render(
      <TooltipProvider>
        <TaskPagePluginSourceGroup sources={[]} selected={null} onSelect={vi.fn()} />
      </TooltipProvider>
    )

    expect(container.querySelector('[data-plugin-task-source]')).toBeNull()
  })

  it('renders one button per contributed source in contribution order', () => {
    render(
      <TooltipProvider>
        <TaskPagePluginSourceGroup sources={[BOARDS, SPRINTS]} selected={null} onSelect={vi.fn()} />
      </TooltipProvider>
    )

    const buttons = screen.getAllByRole('button')
    expect(buttons.map((button) => button.getAttribute('data-plugin-task-source'))).toEqual([
      'boards',
      'sprints'
    ])
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'false')
  })

  it('reports the selection for the clicked source', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(
      <TooltipProvider>
        <TaskPagePluginSourceGroup
          sources={[BOARDS, SPRINTS]}
          selected={null}
          onSelect={onSelect}
        />
      </TooltipProvider>
    )

    await user.click(screen.getByRole('button', { name: 'Sprints' }))
    expect(onSelect).toHaveBeenCalledWith({
      pluginKey: 'orca-samples.issues',
      sourceId: 'sprints'
    })
  })

  it('marks only the selected source as pressed', () => {
    render(
      <TooltipProvider>
        <TaskPagePluginSourceGroup
          sources={[BOARDS, SPRINTS]}
          selected={{ pluginKey: 'orca-samples.issues', sourceId: 'sprints' }}
          onSelect={vi.fn()}
        />
      </TooltipProvider>
    )

    expect(screen.getByRole('button', { name: 'Boards' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Sprints' })).toHaveAttribute('aria-pressed', 'true')
  })
})

const ICON_SVG_DATA_URL = `data:image/svg+xml;base64,${Buffer.from(
  '<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z" /></svg>',
  'utf8'
).toString('base64')}`

function renderSources(sources: ContributedPluginTaskSource[]): void {
  render(
    <TooltipProvider>
      <TaskPagePluginSourceGroup sources={sources} selected={null} onSelect={vi.fn()} />
    </TooltipProvider>
  )
}

function buttonFor(title: string): HTMLElement {
  return screen.getByRole('button', { name: title })
}

function maskIconFor(title: string): HTMLSpanElement {
  const icon = buttonFor(title).querySelector('span')
  if (!icon) {
    throw new Error(`no masked icon rendered for ${title}`)
  }
  return icon
}

function glyphFor(title: string): SVGSVGElement {
  const glyph = buttonFor(title).querySelector('svg')
  if (!glyph) {
    throw new Error(`no glyph rendered for ${title}`)
  }
  return glyph
}

describe('TaskPage contributed source icons', () => {
  it('paints a plugin-supplied asset as a mask so the theme owns its colour', () => {
    renderSources([{ ...BOARDS, icon: 'icons/boards.svg', iconDataUrl: ICON_SVG_DATA_URL }])

    const icon = maskIconFor('Boards')
    expect(icon).toHaveClass('plugin-task-source-icon')
    expect(icon.style.getPropertyValue('--plugin-task-source-icon')).toBe(
      `url("${ICON_SVG_DATA_URL}")`
    )
    expect(icon).toHaveClass('bg-current')
    expect(icon.style.getPropertyValue('background-color')).toBe('')
  })

  it('renders the mapped Lucide glyph for a declared token', () => {
    renderSources([{ ...BOARDS, icon: 'kanban' }])

    expect(glyphFor('Boards')).toHaveClass('lucide-kanban')
  })

  it('falls back to the puzzle glyph for a token outside the map', () => {
    renderSources([{ ...BOARDS, icon: 'not-a-lucide-icon' }])

    expect(glyphFor('Boards')).toHaveClass('lucide-puzzle')
  })

  it('falls back to the puzzle glyph when the source declares no icon', () => {
    renderSources([BOARDS])

    expect(glyphFor('Boards')).toHaveClass('lucide-puzzle')
  })

  it('renders two differently iconed sources distinguishably', () => {
    renderSources([
      { ...BOARDS, icon: 'icons/boards.svg', iconDataUrl: ICON_SVG_DATA_URL },
      { ...SPRINTS, icon: 'kanban' }
    ])

    expect(maskIconFor('Boards').style.getPropertyValue('--plugin-task-source-icon')).toBe(
      `url("${ICON_SVG_DATA_URL}")`
    )
    expect(buttonFor('Boards').querySelector('svg')).toBeNull()
    expect(glyphFor('Sprints')).toHaveClass('lucide-kanban')
  })

  it('shows no visible label beside the icon', () => {
    renderSources([{ ...BOARDS, icon: 'kanban' }])

    expect(buttonFor('Boards').textContent).toBe('')
    expect(screen.queryByText('Boards')).toBeNull()
  })

  it('keeps the title as the accessible name and in the tooltip', async () => {
    const user = userEvent.setup()
    renderSources([{ ...BOARDS, icon: 'kanban' }])

    expect(buttonFor('Boards')).toHaveAttribute('aria-label', 'Boards')

    await user.hover(buttonFor('Boards'))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Boards')
  })
})
