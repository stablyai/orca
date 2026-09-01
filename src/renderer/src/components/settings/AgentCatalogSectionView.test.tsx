// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import {
  AgentCatalogSectionView,
  type AgentCatalogSectionViewProps
} from './AgentCatalogSectionView'
import {
  buildLocalCatalogSnapshot,
  buildReadyCustom,
  buildRepairCustom
} from './agent-catalog-snapshot.fixture'
import type { CustomTuiAgentId } from '../../../../shared/types'

// Render menu content inline and honor `disabled` so the staged (disabled)
// actions are assertable without Radix pointer-capture (repo idiom).
vi.mock('../ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled
  }: {
    children: ReactNode
    onSelect?: () => void
    disabled?: boolean
  }) => (
    <button type="button" data-menu-item disabled={disabled} onClick={onSelect}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />
}))

// @tanstack/react-virtual measures via offsetHeight/getBoundingClientRect, which
// happy-dom reports as zero; feed the container a viewport and rows their estimate.
function isRowElement(el: HTMLElement): boolean {
  return typeof el.hasAttribute === 'function' && el.hasAttribute('data-agent-catalog-row')
}
let restore: (() => void) | undefined
beforeEach(() => {
  const rect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
    const height = isRowElement(this) ? 52 : 500
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
      return isRowElement(this) ? 52 : 500
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

const CUSTOM_ID = 'custom-agent:claude:one' as CustomTuiAgentId

function props(
  overrides: Partial<AgentCatalogSectionViewProps> = {}
): AgentCatalogSectionViewProps {
  return {
    snapshot: buildLocalCatalogSnapshot({
      customAgents: [buildReadyCustom({ id: CUSTOM_ID, base: 'claude', label: 'Nightly Claude' })]
    }),
    detectedIds: null,
    agentCmdOverrides: {},
    onSelectDefault: vi.fn(),
    onToggleEnabled: vi.fn(),
    onEditCustom: vi.fn(),
    onEditBuiltIn: vi.fn(),
    onDeleteCustom: vi.fn(),
    onReviewReferences: vi.fn(),
    onDuplicate: vi.fn(),
    onNewAgent: vi.fn(),
    onRefresh: vi.fn(),
    onRepairEdit: vi.fn(),
    onRepairReplace: vi.fn(),
    onRepairDuplicate: vi.fn(),
    ...overrides
  }
}

const REPAIR_ID = 'custom-agent:codex:11111111-1111-4111-8111-111111111111' as CustomTuiAgentId

function rowElement(container: HTMLElement, key: string): HTMLElement {
  const el = container.querySelector(`[data-agent-catalog-row="${key}"]`)
  if (!el) {
    throw new Error(`row ${key} not mounted`)
  }
  return el as HTMLElement
}

describe('AgentCatalogSectionView default section', () => {
  it('shows the derived Auto default and no attention banner', () => {
    render(
      <AgentCatalogSectionView
        {...props({ snapshot: buildLocalCatalogSnapshot({ defaultAgent: 'auto' }) })}
      />
    )
    expect(screen.getByRole('combobox')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('renders the choose-a-default attention banner for a repair-null default', () => {
    render(
      <AgentCatalogSectionView
        {...props({ snapshot: buildLocalCatalogSnapshot({ defaultAgent: null }) })}
      />
    )
    expect(screen.getByRole('status').textContent).toContain('Choose a default agent')
  })

  it('shows a placeholder trigger, not Auto, for a repair-null default', () => {
    // null resolves to no_agent_selected at launch, so the trigger must not claim Auto.
    render(
      <AgentCatalogSectionView
        {...props({ snapshot: buildLocalCatalogSnapshot({ defaultAgent: null }) })}
      />
    )
    const trigger = screen.getByRole('combobox')
    expect(trigger.textContent).toContain('Choose a default agent')
    expect(trigger.textContent).not.toContain('Auto')
  })

  it('focuses the default combobox on open for a repair-null default (§969)', () => {
    render(
      <AgentCatalogSectionView
        {...props({ snapshot: buildLocalCatalogSnapshot({ defaultAgent: null }) })}
      />
    )
    expect(document.activeElement).toBe(screen.getByRole('combobox'))
  })

  it('does not steal focus when a default is set', () => {
    render(
      <AgentCatalogSectionView
        {...props({ snapshot: buildLocalCatalogSnapshot({ defaultAgent: 'auto' }) })}
      />
    )
    expect(document.activeElement).not.toBe(screen.getByRole('combobox'))
  })
})

describe('AgentCatalogSectionView catalog wiring', () => {
  it('toggles a built-in through its enable switch', () => {
    const onToggleEnabled = vi.fn()
    render(<AgentCatalogSectionView {...props({ onToggleEnabled })} />)
    fireEvent.click(screen.getByRole('switch', { name: /Enable Claude$/ }))
    expect(onToggleEnabled).toHaveBeenCalledWith('claude', false)
  })

  it('routes a custom row Edit and Duplicate to the section handlers', () => {
    const onEditCustom = vi.fn()
    const onDuplicate = vi.fn()
    const { container } = render(
      <AgentCatalogSectionView {...props({ onEditCustom, onDuplicate })} />
    )
    const row = rowElement(container, CUSTOM_ID)
    fireEvent.click(within(row).getByText('Edit'))
    fireEvent.click(within(row).getByText('Duplicate'))
    expect(onEditCustom).toHaveBeenCalledWith(CUSTOM_ID)
    expect(onDuplicate).toHaveBeenCalledWith(CUSTOM_ID)
  })

  it('routes a built-in Edit launch settings to the section handler', () => {
    const onEditBuiltIn = vi.fn()
    const { container } = render(<AgentCatalogSectionView {...props({ onEditBuiltIn })} />)
    const builtIn = rowElement(container, 'claude')
    const editItem = within(builtIn).getByText('Edit launch settings') as HTMLButtonElement
    expect(editItem.disabled).toBe(false)
    fireEvent.click(editItem)
    expect(onEditBuiltIn).toHaveBeenCalledWith('claude')
  })

  it('routes the custom Delete action live to the section handler', () => {
    const onDeleteCustom = vi.fn()
    const { container } = render(<AgentCatalogSectionView {...props({ onDeleteCustom })} />)
    const custom = rowElement(container, CUSTOM_ID)
    const deleteItem = within(custom).getByText('Delete') as HTMLButtonElement
    expect(deleteItem.disabled).toBe(false)
    fireEvent.click(deleteItem)
    expect(onDeleteCustom).toHaveBeenCalledWith({
      id: CUSTOM_ID,
      label: 'Nightly Claude',
      baseAgent: 'claude',
      isDefault: false
    })
  })

  it('routes a deleted tombstone Review references to the section handler', () => {
    const onReviewReferences = vi.fn()
    const snapshot = buildLocalCatalogSnapshot({
      deletedCustomAgents: [
        { id: CUSTOM_ID, baseAgent: 'claude', label: 'Retired Claude', deletedAt: 1 }
      ]
    })
    const { container } = render(
      <AgentCatalogSectionView {...props({ snapshot, onReviewReferences })} />
    )
    const tombstone = rowElement(container, CUSTOM_ID)
    fireEvent.click(within(tombstone).getByText('Review references'))
    expect(onReviewReferences).toHaveBeenCalledWith({
      id: CUSTOM_ID,
      label: 'Retired Claude',
      baseAgent: 'claude'
    })
  })

  it('routes a canonical repair row to repair-edit with its id, token, and base', () => {
    const onRepairEdit = vi.fn()
    const snapshot = buildLocalCatalogSnapshot({
      customAgents: [
        buildRepairCustom({
          repairToken: 'tok-edit',
          id: REPAIR_ID,
          base: 'codex',
          label: 'Broken Codex'
        })
      ]
    })
    const { container } = render(<AgentCatalogSectionView {...props({ snapshot, onRepairEdit })} />)
    const row = rowElement(container, `repair:tok-edit`)
    fireEvent.click(within(row).getByText('Repair'))
    expect(onRepairEdit).toHaveBeenCalledWith({
      id: REPAIR_ID,
      repairToken: 'tok-edit',
      baseAgent: 'codex'
    })
  })

  it('routes a malformed (unaddressable) repair row to replace-or-discard', () => {
    const onRepairReplace = vi.fn()
    // Base present but no addressable id → not editable in place, so it routes to
    // replace-or-discard rather than the editor.
    const snapshot = buildLocalCatalogSnapshot({
      customAgents: [buildRepairCustom({ repairToken: 'tok-bad', base: 'codex', label: null })]
    })
    const { container } = render(
      <AgentCatalogSectionView {...props({ snapshot, onRepairReplace })} />
    )
    const row = rowElement(container, `repair:tok-bad`)
    fireEvent.click(within(row).getByText('Repair'))
    expect(onRepairReplace).toHaveBeenCalledWith({ repairToken: 'tok-bad', label: null })
  })

  it('routes a duplicate-id row to the whole group as one atomic target', () => {
    const onRepairDuplicate = vi.fn()
    const dupIssue = [{ field: 'identity', reason: 'duplicate_id' } as const]
    const snapshot = buildLocalCatalogSnapshot({
      customAgents: [
        buildRepairCustom({ repairToken: 'dup-a', id: REPAIR_ID, base: 'codex', issues: dupIssue }),
        buildRepairCustom({ repairToken: 'dup-b', id: REPAIR_ID, base: 'codex', issues: dupIssue })
      ]
    })
    const { container } = render(
      <AgentCatalogSectionView {...props({ snapshot, onRepairDuplicate })} />
    )
    fireEvent.click(within(rowElement(container, 'repair:dup-a')).getByText('Repair'))
    expect(onRepairDuplicate).toHaveBeenCalledTimes(1)
    const target = onRepairDuplicate.mock.calls[0][0]
    expect(target.duplicateId).toBe(REPAIR_ID)
    expect(target.rows.map((r: { repairToken: string }) => r.repairToken)).toEqual([
      'dup-a',
      'dup-b'
    ])
  })

  it('fires New agent and hides it when read-only', () => {
    const onNewAgent = vi.fn()
    const { rerender } = render(<AgentCatalogSectionView {...props({ onNewAgent })} />)
    fireEvent.click(screen.getByText('New agent'))
    expect(onNewAgent).toHaveBeenCalledTimes(1)
    rerender(<AgentCatalogSectionView {...props({ onNewAgent, readOnly: true })} />)
    expect(screen.queryByText('New agent')).toBeNull()
  })
})
