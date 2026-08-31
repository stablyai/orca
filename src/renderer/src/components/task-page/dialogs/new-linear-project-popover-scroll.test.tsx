// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

function listState<T>(data: T[]): { data: T[]; loading: boolean; error: string | null } {
  return { data, loading: false, error: null }
}

const MEMBERS = Array.from({ length: 30 }, (_, i) => ({
  id: `member-${i}`,
  name: `Member ${i}`,
  displayName: `Member ${i}`,
  email: `member${i}@example.test`
}))

const LABELS = Array.from({ length: 30 }, (_, i) => ({
  id: `label-${i}`,
  name: `Label ${i}`,
  color: '#888888'
}))

async function renderFields(): Promise<void> {
  const { NewLinearProjectFields } = await import('./new-linear-project-fields')
  await act(async () =>
    root.render(
      <NewLinearProjectFields
        newLinearProjectSubmitting={false}
        newLinearProjectPriority={0}
        setNewLinearProjectPriority={() => {}}
        newLinearProjectMembers={listState(MEMBERS) as never}
        newLinearProjectLeadId={null}
        setNewLinearProjectLeadId={() => {}}
        newLinearProjectMemberIds={[]}
        setNewLinearProjectMemberIds={() => {}}
        newLinearProjectLabelIds={[]}
        setNewLinearProjectLabelIds={() => {}}
        newLinearProjectLabels={listState(LABELS) as never}
        newLinearProjectStartDate=""
        setNewLinearProjectStartDate={() => {}}
        newLinearProjectTargetDate=""
        setNewLinearProjectTargetDate={() => {}}
      />
    )
  )
}

function triggers(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-slot="popover-trigger"]')]
}

async function toggle(trigger: HTMLElement): Promise<void> {
  // Radix opens on pointerdown, not a synthetic click.
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }))
    trigger.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' }))
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function openContent(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-slot="popover-content"]')
  if (!el) {
    throw new Error('Popover content did not render')
  }
  return el
}

describe('Linear new-project dialog popovers', () => {
  it('renders every attribute popover as a capped scroller that the wheel shim can drive', async () => {
    await renderFields()
    const all = triggers()
    expect(all.length).toBe(4)

    for (const [index, trigger] of all.entries()) {
      await toggle(trigger)
      const content = openContent()

      // The marker is what supplies overflow-y and opts into popover.tsx's
      // wheel shim, which Radix's dialog scroll-lock otherwise defeats.
      expect(content.className, `popover ${index} is not a capped scroller`).toContain(
        'popover-scroll-content'
      )
      expect(content.className).toContain('scrollbar-sleek')

      // A nested fixed-height scroller inside the cap strands its own overflow.
      const nested = [...content.querySelectorAll<HTMLElement>('div')].filter((el) => {
        const tokens = new Set(el.className.split(/\s+/))
        return (
          [...tokens].some((t) => /^max-h-(\d+|\[.+\])$/.test(t)) && tokens.has('overflow-y-auto')
        )
      })
      expect(
        nested.map((el) => el.className),
        `popover ${index} nests a scroller`
      ).toEqual([])

      await toggle(trigger)
    }
  })

  it('keeps the team switcher in the same pattern', () => {
    // The team switcher lives in the dialog shell, which needs the whole task
    // page to mount; assert on its source instead.
    const source = readFileSync(
      'src/renderer/src/components/task-page/dialogs/new-linear-project-dialog.tsx',
      'utf8'
    )
    const tags = [...source.matchAll(/<PopoverContent\b[^>]*?>/gs)].map((m) => m[0])

    expect(tags.length).toBeGreaterThanOrEqual(1)
    for (const tag of tags) {
      const className = tag.match(/\bclassName="([^"]*)"/)?.[1] ?? null
      expect(className, `className must be a plain literal: ${tag}`).not.toBeNull()
      expect(className).toContain('popover-scroll-content')
      expect(className).toContain('scrollbar-sleek')
    }
  })
})
