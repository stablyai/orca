import { describe, expect, it, vi } from 'vitest'
import type { SettingsImportPreview } from '../../../../shared/settings-portability'
import { SettingsImportModal } from './SettingsImportModal'
import { PortableSettingsChangeSummary } from './PortableSettingsChangeSummary'
import { Button } from '../ui/button'

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function extractText(node: unknown): string {
  if (node == null) {
    return ''
  }
  if (typeof node === 'string') {
    return node
  }
  if (typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(extractText).join('')
  }
  const el = node as ReactElementLike
  // The summary child renders its content from props (not children), so it is
  // expanded by calling it directly — safe because it is hook-free.
  if (el.type === PortableSettingsChangeSummary) {
    return extractText(PortableSettingsChangeSummary(el.props as never))
  }
  if (el.props?.children) {
    return extractText(el.props.children)
  }
  return ''
}

function findButtons(node: unknown): { text: string; onClick: () => void }[] {
  const buttons: { text: string; onClick: () => void }[] = []

  function traverse(n: unknown): void {
    if (n == null || typeof n === 'string' || typeof n === 'number') {
      return
    }
    if (Array.isArray(n)) {
      n.forEach(traverse)
      return
    }
    const el = n as ReactElementLike
    if (el.type === Button) {
      buttons.push({
        text: extractText(el.props.children),
        onClick: el.props.onClick as () => void
      })
    }
    if (el.props?.children) {
      traverse(el.props.children)
    }
  }

  traverse(node)
  return buttons
}

function containsText(node: unknown, search: string): boolean {
  return extractText(node).includes(search)
}

describe('SettingsImportModal', () => {
  const basePreview: SettingsImportPreview = {
    ok: true,
    filePath: '/tmp/orca-settings.json',
    portableSettingCount: 3,
    changedSettingKeys: ['theme', 'terminalFontSize', 'sourceControlAi'],
    skippedSettingKeys: ['workspaceDir'],
    includesKeybindings: true,
    changedKeybindings: true
  }

  it('renders changed settings, keybinding note, and skipped keys with apply button', () => {
    const onOpenChange = vi.fn()
    const onApply = vi.fn()

    const element = SettingsImportModal({
      open: true,
      onOpenChange,
      preview: basePreview,
      applying: false,
      applyError: null,
      onApply
    })

    expect(containsText(element, 'Import Settings')).toBe(true)
    expect(containsText(element, '/tmp/orca-settings.json')).toBe(true)
    expect(containsText(element, 'Settings to update')).toBe(true)
    expect(containsText(element, 'Font Size')).toBe(true)
    expect(containsText(element, 'Theme')).toBe(true)
    expect(containsText(element, 'Source Control AI')).toBe(true)
    expect(containsText(element, 'sourceControlAi')).toBe(false)
    expect(containsText(element, 'Keyboard shortcuts will be replaced')).toBe(true)
    expect(containsText(element, 'Settings not imported')).toBe(true)
    expect(containsText(element, 'specific to another machine')).toBe(true)
    expect(containsText(element, 'workspaceDir')).toBe(true)

    const buttons = findButtons(element)
    const importButton = buttons.find((b) => b.text === 'Import')
    expect(importButton).toBeDefined()
    importButton?.onClick()
    expect(onApply).toHaveBeenCalledTimes(1)

    const cancelButton = buttons.find((b) => b.text === 'Cancel')
    cancelButton?.onClick()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('shows already-matched message and no apply button when nothing changes', () => {
    const element = SettingsImportModal({
      open: true,
      onOpenChange: () => {},
      preview: {
        ...basePreview,
        changedSettingKeys: [],
        skippedSettingKeys: [],
        includesKeybindings: true,
        changedKeybindings: false
      },
      applying: false,
      applyError: null,
      onApply: () => {}
    })

    expect(containsText(element, 'your current settings already match')).toBe(true)
    expect(findButtons(element).some((b) => b.text === 'Import')).toBe(false)
  })

  it('shows the apply error inline', () => {
    const element = SettingsImportModal({
      open: true,
      onOpenChange: () => {},
      preview: basePreview,
      applying: false,
      applyError: 'Keybindings export must contain a JSON object.',
      onApply: () => {}
    })

    expect(containsText(element, 'Keybindings export must contain a JSON object.')).toBe(true)
  })
})
