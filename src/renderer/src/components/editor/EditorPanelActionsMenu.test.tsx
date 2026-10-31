import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorPanelActionsMenu } from './EditorPanelActionsMenu'

const checkboxItems = vi.hoisted(() => ({
  list: [] as {
    checked?: boolean
    disabled?: boolean
    label: string
    onCheckedChange?: (checked: boolean) => void
  }[]
}))

vi.mock('@/components/ui/dropdown-menu', async () => {
  const React_ = await import('react')
  const passthrough = ({ children }: { children?: React.ReactNode }) =>
    React_.createElement(React_.Fragment, null, children)
  return {
    DropdownMenu: passthrough,
    DropdownMenuContent: passthrough,
    DropdownMenuItem: passthrough,
    DropdownMenuSeparator: () => null,
    DropdownMenuTrigger: passthrough,
    DropdownMenuCheckboxItem: ({
      checked,
      children,
      disabled,
      onCheckedChange
    }: {
      checked?: boolean
      children?: React.ReactNode
      disabled?: boolean
      onCheckedChange?: (checked: boolean) => void
    }) => {
      const label = React_.Children.toArray(children)
        .filter((child): child is string => typeof child === 'string')
        .join('')
      checkboxItems.list.push({ checked, disabled, label, onCheckedChange })
      return React_.createElement(React_.Fragment, null, children)
    }
  }
})

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null
}))

describe('EditorPanelActionsMenu', () => {
  beforeEach(() => {
    checkboxItems.list = []
  })

  it('shows front matter as a view preference beside word wrap', () => {
    const onToggleMarkdownFrontmatter = vi.fn()
    renderToStaticMarkup(
      <EditorPanelActionsMenu
        isDiffSurface={false}
        diffWordWrap={false}
        diffShowWhitespace={false}
        editorWordWrap
        editorLineNumbers
        shouldShowMarkdownExportAction
        canExportMarkdownToPdf
        canShowMarkdownFrontmatterToggle
        markdownFrontmatterVisible
        onToggleDiffWordWrap={vi.fn()}
        onToggleDiffWhitespace={vi.fn()}
        onToggleEditorWordWrap={vi.fn()}
        onToggleEditorLineNumbers={vi.fn()}
        onToggleMarkdownFrontmatter={onToggleMarkdownFrontmatter}
        onExportMarkdownToPdf={vi.fn()}
      />
    )
    expect(checkboxItems.list.map(({ label }) => label)).toEqual([
      'Word Wrap',
      'Line Numbers',
      'Front Matter'
    ])
    expect(checkboxItems.list[2]?.checked).toBe(true)
    checkboxItems.list[2]?.onCheckedChange?.(false)
    expect(onToggleMarkdownFrontmatter).toHaveBeenCalledOnce()
  })

  it('shows Word Wrap for normal file tabs using editorWordWrap (#9974)', () => {
    const onToggleDiffWordWrap = vi.fn()
    const onToggleEditorWordWrap = vi.fn()
    const onToggleEditorLineNumbers = vi.fn()
    renderToStaticMarkup(
      React.createElement(EditorPanelActionsMenu, {
        isDiffSurface: false,
        diffWordWrap: false,
        diffShowWhitespace: false,
        editorWordWrap: true,
        editorLineNumbers: true,
        shouldShowMarkdownExportAction: false,
        canExportMarkdownToPdf: false,
        canShowMarkdownFrontmatterToggle: false,
        markdownFrontmatterVisible: false,
        onToggleDiffWordWrap,
        onToggleDiffWhitespace: () => {},
        onToggleEditorWordWrap,
        onToggleEditorLineNumbers,
        onToggleMarkdownFrontmatter: () => {},
        onExportMarkdownToPdf: () => {}
      })
    )

    expect(checkboxItems.list).toHaveLength(2)
    expect(checkboxItems.list[0]).toMatchObject({ checked: true, label: 'Word Wrap' })
    expect(checkboxItems.list[1]).toMatchObject({ checked: true, label: 'Line Numbers' })
    checkboxItems.list[0]?.onCheckedChange?.(false)
    checkboxItems.list[1]?.onCheckedChange?.(false)
    expect(onToggleEditorWordWrap).toHaveBeenCalledOnce()
    expect(onToggleEditorLineNumbers).toHaveBeenCalledOnce()
    expect(onToggleDiffWordWrap).not.toHaveBeenCalled()
  })

  it('binds Word Wrap to diffWordWrap on diff surfaces', () => {
    const onToggleDiffWordWrap = vi.fn()
    const onToggleEditorWordWrap = vi.fn()
    renderToStaticMarkup(
      React.createElement(EditorPanelActionsMenu, {
        isDiffSurface: true,
        diffWordWrap: true,
        diffShowWhitespace: false,
        editorWordWrap: false,
        editorLineNumbers: false,
        shouldShowMarkdownExportAction: false,
        canExportMarkdownToPdf: false,
        canShowMarkdownFrontmatterToggle: false,
        markdownFrontmatterVisible: false,
        onToggleDiffWordWrap,
        onToggleDiffWhitespace: () => {},
        onToggleEditorWordWrap,
        onToggleEditorLineNumbers: () => {},
        onToggleMarkdownFrontmatter: () => {},
        onExportMarkdownToPdf: () => {}
      })
    )

    expect(checkboxItems.list).toHaveLength(3)
    expect(checkboxItems.list[0]).toMatchObject({ checked: true, label: 'Word Wrap' })
    expect(checkboxItems.list[1]).toMatchObject({ checked: false, label: 'Line Numbers' })
    checkboxItems.list[0]?.onCheckedChange?.(false)
    expect(onToggleDiffWordWrap).toHaveBeenCalledOnce()
    expect(onToggleEditorWordWrap).not.toHaveBeenCalled()
  })

  it('shows and binds Show Whitespace on diff surfaces', () => {
    const onToggleDiffWhitespace = vi.fn()
    renderToStaticMarkup(
      React.createElement(EditorPanelActionsMenu, {
        isDiffSurface: true,
        diffWordWrap: false,
        diffShowWhitespace: true,
        editorWordWrap: false,
        editorLineNumbers: true,
        shouldShowMarkdownExportAction: false,
        canExportMarkdownToPdf: false,
        canShowMarkdownFrontmatterToggle: false,
        markdownFrontmatterVisible: false,
        onToggleDiffWordWrap: () => {},
        onToggleDiffWhitespace,
        onToggleEditorWordWrap: () => {},
        onToggleEditorLineNumbers: () => {},
        onToggleMarkdownFrontmatter: () => {},
        onExportMarkdownToPdf: () => {}
      })
    )

    expect(checkboxItems.list).toHaveLength(3)
    expect(checkboxItems.list[1]).toMatchObject({ checked: true, label: 'Line Numbers' })
    expect(checkboxItems.list[2]).toMatchObject({
      checked: true,
      label: 'Show Whitespace'
    })
    checkboxItems.list[2]?.onCheckedChange?.(false)
    expect(onToggleDiffWhitespace).toHaveBeenCalledOnce()
  })

  it('omits line numbers when canToggleLineNumbers is false', () => {
    renderToStaticMarkup(
      React.createElement(EditorPanelActionsMenu, {
        isDiffSurface: false,
        diffWordWrap: false,
        diffShowWhitespace: false,
        editorWordWrap: true,
        editorLineNumbers: true,
        canToggleLineNumbers: false,
        shouldShowMarkdownExportAction: false,
        canExportMarkdownToPdf: false,
        canShowMarkdownFrontmatterToggle: false,
        markdownFrontmatterVisible: false,
        onToggleDiffWordWrap: () => {},
        onToggleDiffWhitespace: () => {},
        onToggleEditorWordWrap: () => {},
        onToggleEditorLineNumbers: () => {},
        onToggleMarkdownFrontmatter: () => {},
        onExportMarkdownToPdf: () => {}
      })
    )

    expect(checkboxItems.list.map(({ label }) => label)).toEqual(['Word Wrap'])
  })

  it('disables line numbers when isLineNumbersDisabled is true', () => {
    renderToStaticMarkup(
      React.createElement(EditorPanelActionsMenu, {
        isDiffSurface: false,
        diffWordWrap: false,
        diffShowWhitespace: false,
        editorWordWrap: true,
        editorLineNumbers: true,
        isLineNumbersDisabled: true,
        shouldShowMarkdownExportAction: false,
        canExportMarkdownToPdf: false,
        canShowMarkdownFrontmatterToggle: false,
        markdownFrontmatterVisible: false,
        onToggleDiffWordWrap: () => {},
        onToggleDiffWhitespace: () => {},
        onToggleEditorWordWrap: () => {},
        onToggleEditorLineNumbers: () => {},
        onToggleMarkdownFrontmatter: () => {},
        onExportMarkdownToPdf: () => {}
      })
    )

    const item = checkboxItems.list.find(({ label }) => label === 'Line Numbers')
    expect(item).toMatchObject({ checked: true, disabled: true, label: 'Line Numbers' })
  })
})
