import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PerforceChangelist,
  PerforceEntry
} from '../../../../../shared/perforce/perforce-types'
import { PerforceFileContextMenu } from './perforce-file-context-menu'

type ItemProps = { onSelect?: () => void; children?: React.ReactNode }
type TriggerProps = { disabled?: boolean; children?: React.ReactNode }

const captured = vi.hoisted(() => {
  const items: { onSelect?: () => void }[] = []
  const triggers: { disabled?: boolean }[] = []
  return { items, triggers }
})

vi.mock('@/components/ui/context-menu', async () => {
  const React_ = await import('react')
  const passthrough = ({ children }: { children?: React.ReactNode }) =>
    React_.createElement(React_.Fragment, null, children)
  return {
    ContextMenu: passthrough,
    ContextMenuContent: passthrough,
    ContextMenuItem: (props: ItemProps) => {
      captured.items.push(props)
      return React_.createElement(React_.Fragment, null, props.children)
    },
    ContextMenuSeparator: () => null,
    ContextMenuSub: passthrough,
    ContextMenuSubContent: passthrough,
    ContextMenuSubTrigger: (props: TriggerProps) => {
      captured.triggers.push(props)
      return React_.createElement(React_.Fragment, null, props.children)
    },
    ContextMenuTrigger: passthrough
  }
})

const entry = (path: string, changelist: 'default' | number): PerforceEntry => ({
  path,
  action: 'edit',
  group: 'opened',
  changelist
})
const changelist = (id: number, description: string): PerforceChangelist => ({
  id,
  description,
  shelvedFiles: []
})

function render(targets: PerforceEntry[], changelists: PerforceChangelist[]) {
  const onMove = vi.fn()
  const onNew = vi.fn()
  const markup = renderToStaticMarkup(
    <PerforceFileContextMenu
      targets={targets}
      changelists={changelists}
      onMoveToChangelist={onMove}
      onMoveToNewChangelist={onNew}
    >
      <div>row</div>
    </PerforceFileContextMenu>
  )
  return { markup, onMove, onNew }
}

describe('PerforceFileContextMenu', () => {
  beforeEach(() => {
    captured.items.length = 0
    captured.triggers.length = 0
  })

  it('offers every changelist as a destination for a default-changelist file', () => {
    const { markup, onMove } = render(
      [entry('a.txt', 'default')],
      [changelist(12, 'Fix it'), changelist(13, 'Other')]
    )
    expect(markup).toContain('Move to existing changelist')
    expect(markup).toContain('Changelist 12 · Fix it')
    expect(markup).not.toContain('Default changelist')
    captured.items[0]?.onSelect?.()
    expect(onMove).toHaveBeenCalledWith(12)
  })

  it('omits the changelist the whole selection already sits in and offers default', () => {
    const { markup } = render(
      [entry('a.txt', 12), entry('b.txt', 12)],
      [changelist(12, 'Fix it'), changelist(13, 'Other')]
    )
    expect(markup).toContain('Default changelist')
    expect(markup).toContain('Changelist 13')
    expect(markup).not.toContain('Changelist 12')
    expect(markup).toContain('Move 2 files to new changelist…')
  })

  it('disables the existing-changelist submenu when there is nowhere to move', () => {
    render([entry('a.txt', 'default')], [])
    expect(captured.triggers[0]?.disabled).toBe(true)
  })

  it('reports the new-changelist choice', () => {
    const { onNew } = render([entry('a.txt', 'default')], [])
    captured.items.at(-1)?.onSelect?.()
    expect(onNew).toHaveBeenCalledTimes(1)
  })
})
