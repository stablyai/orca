import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorPanelMarkdownActionsMenu } from './EditorPanelMarkdownActionsMenu'

const capturedItems = vi.hoisted(() => ({
  checkboxItems: [] as {
    checked?: boolean
    label: string
    onCheckedChange?: (checked: boolean) => void
  }[],
  menuItems: [] as {
    label: string
    onSelect?: () => void
  }[]
}))

vi.mock('@/components/ui/dropdown-menu', async () => {
  const React_ = await import('react')
  const passthrough = ({ children }: { children?: React.ReactNode }) =>
    React_.createElement(React_.Fragment, null, children)
  return {
    DropdownMenu: passthrough,
    DropdownMenuContent: passthrough,
    DropdownMenuItem: ({
      children,
      onSelect
    }: {
      children?: React.ReactNode
      onSelect?: () => void
    }) => {
      const label = React_.Children.toArray(children)
        .filter((child): child is string => typeof child === 'string')
        .join('')
      capturedItems.menuItems.push({ label, onSelect })
      return React_.createElement(React_.Fragment, null, children)
    },
    DropdownMenuSeparator: () => null,
    DropdownMenuTrigger: passthrough,
    DropdownMenuCheckboxItem: ({
      checked,
      children,
      onCheckedChange
    }: {
      checked?: boolean
      children?: React.ReactNode
      onCheckedChange?: (checked: boolean) => void
    }) => {
      const label = React_.Children.toArray(children)
        .filter((child): child is string => typeof child === 'string')
        .join('')
      capturedItems.checkboxItems.push({ checked, label, onCheckedChange })
      return React_.createElement(React_.Fragment, null, children)
    }
  }
})

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

describe('EditorPanelMarkdownActionsMenu', () => {
  beforeEach(() => {
    capturedItems.checkboxItems = []
    capturedItems.menuItems = []
  })

  it('shows Word Wrap for normal file tabs using editorWordWrap (#9974)', () => {
    const onToggleDiffWordWrap = vi.fn()
    const onToggleEditorWordWrap = vi.fn()
    renderToStaticMarkup(
      React.createElement(EditorPanelMarkdownActionsMenu, {
        isMarkdown: false,
        isDiffSurface: false,
        diffWordWrap: false,
        editorWordWrap: true,
        shouldShowMarkdownExportAction: false,
        canExportMarkdownToPdf: false,
        canShowMarkdownFrontmatterToggle: false,
        markdownFrontmatterVisible: false,
        onToggleDiffWordWrap,
        onToggleEditorWordWrap,
        onToggleMarkdownFrontmatter: () => {},
        onExportMarkdownToPdf: () => {}
      })
    )

    expect(capturedItems.checkboxItems).toHaveLength(1)
    expect(capturedItems.checkboxItems[0]).toMatchObject({ checked: true, label: 'Word Wrap' })
    capturedItems.checkboxItems[0]?.onCheckedChange?.(false)
    expect(onToggleEditorWordWrap).toHaveBeenCalledOnce()
    expect(onToggleDiffWordWrap).not.toHaveBeenCalled()
  })

  it('binds Word Wrap to diffWordWrap on diff surfaces', () => {
    const onToggleDiffWordWrap = vi.fn()
    const onToggleEditorWordWrap = vi.fn()
    renderToStaticMarkup(
      React.createElement(EditorPanelMarkdownActionsMenu, {
        isMarkdown: false,
        isDiffSurface: true,
        diffWordWrap: true,
        editorWordWrap: false,
        shouldShowMarkdownExportAction: false,
        canExportMarkdownToPdf: false,
        canShowMarkdownFrontmatterToggle: false,
        markdownFrontmatterVisible: false,
        onToggleDiffWordWrap,
        onToggleEditorWordWrap,
        onToggleMarkdownFrontmatter: () => {},
        onExportMarkdownToPdf: () => {}
      })
    )

    expect(capturedItems.checkboxItems).toHaveLength(1)
    expect(capturedItems.checkboxItems[0]).toMatchObject({ checked: true, label: 'Word Wrap' })
    capturedItems.checkboxItems[0]?.onCheckedChange?.(false)
    expect(onToggleDiffWordWrap).toHaveBeenCalledOnce()
    expect(onToggleEditorWordWrap).not.toHaveBeenCalled()
  })

  it('opens a normal Markdown file in a detached window', () => {
    const onOpenMarkdownInNewWindow = vi.fn()
    renderToStaticMarkup(
      React.createElement(EditorPanelMarkdownActionsMenu, {
        isMarkdown: true,
        isDiffSurface: false,
        diffWordWrap: false,
        editorWordWrap: true,
        shouldShowMarkdownExportAction: false,
        canExportMarkdownToPdf: false,
        canShowMarkdownFrontmatterToggle: false,
        markdownFrontmatterVisible: false,
        onToggleDiffWordWrap: () => {},
        onToggleEditorWordWrap: () => {},
        onToggleMarkdownFrontmatter: () => {},
        onExportMarkdownToPdf: () => {},
        onOpenMarkdownInNewWindow
      })
    )

    const item = capturedItems.menuItems.find(({ label }) => label === 'Open in New Window')
    expect(item).toBeDefined()
    item?.onSelect?.()
    expect(onOpenMarkdownInNewWindow).toHaveBeenCalledOnce()
  })
})
