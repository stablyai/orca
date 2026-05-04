import { describe, expect, it, vi } from 'vitest'
import type { GhosttyImportPreview } from '../../../../shared/types'
import { GhosttyImportModal } from './GhosttyImportModal'
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
  if (el.props?.children) {
    return extractText(el.props.children)
  }
  return ''
}

function findButtons(node: unknown): { text: string; onClick: () => void }[] {
  const buttons: { text: string; onClick: () => void }[] = []

  function traverse(n: unknown): void {
    if (n == null) {
      return
    }
    if (typeof n === 'string' || typeof n === 'number') {
      return
    }
    if (Array.isArray(n)) {
      n.forEach(traverse)
      return
    }
    const el = n as ReactElementLike
    if (el.type === Button) {
      const text = extractText(el.props.children)
      buttons.push({ text, onClick: el.props.onClick as () => void })
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

describe('GhosttyImportModal', () => {
  const basePreview: GhosttyImportPreview = {
    found: true,
    configPath: '/Users/alice/.config/ghostty/config',
    diff: { terminalFontSize: 14, terminalFontFamily: 'JetBrains Mono' },
    unsupportedKeys: ['background']
  }

  it('renders preview with apply and cancel buttons when not applied', () => {
    const onOpenChange = vi.fn()
    const onApply = vi.fn()

    const element = GhosttyImportModal({
      open: true,
      onOpenChange,
      preview: basePreview,
      loading: false,
      onApply,
      applied: false
    })

    expect(containsText(element, 'Import from Ghostty')).toBe(true)
    expect(containsText(element, 'Settings to update')).toBe(true)
    expect(containsText(element, 'Unsupported keys')).toBe(true)

    const buttons = findButtons(element)
    expect(buttons.some((b) => b.text === 'Cancel')).toBe(true)
    expect(buttons.some((b) => b.text === 'Apply Changes')).toBe(true)
    expect(buttons.some((b) => b.text === 'Done')).toBe(false)

    const applyButton = buttons.find((b) => b.text === 'Apply Changes')
    applyButton?.onClick()
    expect(onApply).toHaveBeenCalledTimes(1)

    const cancelButton = buttons.find((b) => b.text === 'Cancel')
    cancelButton?.onClick()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('renders success summary with done button when applied', () => {
    const onOpenChange = vi.fn()
    const onApply = vi.fn()

    const element = GhosttyImportModal({
      open: true,
      onOpenChange,
      preview: basePreview,
      loading: false,
      onApply,
      applied: true
    })

    expect(containsText(element, 'Import complete')).toBe(true)
    expect(containsText(element, 'Font Size')).toBe(true)
    expect(containsText(element, 'JetBrains Mono')).toBe(true)

    const buttons = findButtons(element)
    expect(buttons.some((b) => b.text === 'Done')).toBe(true)
    expect(buttons.some((b) => b.text === 'Apply Changes')).toBe(false)
    expect(buttons.some((b) => b.text === 'Cancel')).toBe(false)

    const doneButton = buttons.find((b) => b.text === 'Done')
    doneButton?.onClick()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('shows loading state when loading', () => {
    const element = GhosttyImportModal({
      open: true,
      onOpenChange: () => {},
      preview: null,
      loading: true,
      onApply: () => {},
      applied: false
    })

    expect(containsText(element, 'Loading preview')).toBe(true)
    expect(findButtons(element).some((b) => b.text === 'Apply Changes')).toBe(false)
  })

  it('shows no-config message when preview is not found', () => {
    const element = GhosttyImportModal({
      open: true,
      onOpenChange: () => {},
      preview: { found: false, diff: {}, unsupportedKeys: [] },
      loading: false,
      onApply: () => {},
      applied: false
    })

    expect(containsText(element, 'No Ghostty config found')).toBe(true)
    expect(findButtons(element).some((b) => b.text === 'Apply Changes')).toBe(false)
  })

  it('shows already-matched message when diff is empty', () => {
    const element = GhosttyImportModal({
      open: true,
      onOpenChange: () => {},
      preview: { found: true, configPath: '/path', diff: {}, unsupportedKeys: [] },
      loading: false,
      onApply: () => {},
      applied: false
    })

    expect(containsText(element, 'No new settings to import')).toBe(true)
    expect(findButtons(element).some((b) => b.text === 'Apply Changes')).toBe(false)
  })
})
