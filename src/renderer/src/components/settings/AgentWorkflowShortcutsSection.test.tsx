import { describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'
import { AgentWorkflowShortcutsSection } from './AgentWorkflowShortcutsSection'
import { SIDEBAR_QUICK_CREATE_TITLE } from './agent-workflow-shortcuts-copy'

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function visit(node: unknown, cb: (node: ReactElementLike) => void): void {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => visit(entry, cb))
    return
  }
  const element = node as ReactElementLike
  cb(element)
  if (element.props?.children) {
    visit(element.props.children, cb)
  }
}

function findSwitchRow(node: unknown): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (
      entry.props.ariaLabel === SIDEBAR_QUICK_CREATE_TITLE &&
      typeof entry.props.checked === 'boolean' &&
      typeof entry.props.onChange === 'function'
    ) {
      found = entry
    }
  })
  if (!found) {
    throw new Error('switch row not found')
  }
  return found
}

function buildSettings(quickCreateWorkspaceWithDefaultAgent: boolean): GlobalSettings {
  return {
    quickCreateWorkspaceWithDefaultAgent
  } as GlobalSettings
}

describe('AgentWorkflowShortcutsSection', () => {
  it('gives the quick-create switch an accessible name', () => {
    const element = AgentWorkflowShortcutsSection({
      settings: buildSettings(false),
      updateSettings: vi.fn()
    })

    const toggle = findSwitchRow(element)

    expect(toggle.props.ariaLabel).toBe(SIDEBAR_QUICK_CREATE_TITLE)
  })

  it('toggles quick-create from the current setting value', () => {
    const updateSettings = vi.fn()
    const element = AgentWorkflowShortcutsSection({
      settings: buildSettings(false),
      updateSettings
    })

    const toggle = findSwitchRow(element)
    ;(toggle.props.onChange as () => void)()

    expect(updateSettings).toHaveBeenCalledWith({
      quickCreateWorkspaceWithDefaultAgent: true
    })
  })
})
