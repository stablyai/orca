// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskPresetButtons } from './task-preset-buttons'

const PRESETS = [
  { id: 'assigned', label: 'Assigned' },
  { id: 'created', label: 'Created' },
  { id: 'all', label: 'All' },
  { id: 'completed', label: 'Completed' }
] as const

let container: HTMLDivElement | null = null
let root: Root | null = null

function render(node: React.ReactNode): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(node)
  })
  return container
}

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  container?.remove()
  root = null
  container = null
})

describe('TaskPresetButtons', () => {
  it('marks only the active preset as pressed', () => {
    const el = render(
      <TaskPresetButtons presets={PRESETS} activeId="created" onSelect={() => {}} />
    )
    const buttons = [...el.querySelectorAll('button')]
    expect(buttons.map((b) => b.textContent)).toEqual(['Assigned', 'Created', 'All', 'Completed'])
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual([
      'false',
      'true',
      'false',
      'false'
    ])
  })

  it('pins no preset when the active id is null, so a live search wins', () => {
    const el = render(<TaskPresetButtons presets={PRESETS} activeId={null} onSelect={() => {}} />)
    expect(
      [...el.querySelectorAll('button')].every((b) => b.getAttribute('aria-pressed') === 'false')
    ).toBe(true)
  })

  it('reports the selected preset id', () => {
    const onSelect = vi.fn()
    const el = render(<TaskPresetButtons presets={PRESETS} activeId="all" onSelect={onSelect} />)
    act(() => {
      el.querySelectorAll('button')[3]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSelect).toHaveBeenCalledWith('completed')
  })

  it('exposes the row as a labelled group', () => {
    const el = render(
      <TaskPresetButtons
        presets={PRESETS}
        activeId="all"
        onSelect={() => {}}
        ariaLabel="Linear issue preset"
      />
    )
    const group = el.querySelector('[role="group"]')
    expect(group?.getAttribute('aria-label')).toBe('Linear issue preset')
  })
})
