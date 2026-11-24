import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { FolderIcon } from '@/components/icons/FileTypeIcon'
import { FileExplorerIndentGuides } from './FileExplorerIndentGuides'
import { InlineInputRow } from './file-explorer/mutations/file-explorer-inline-input-row'
import { FILE_EXPLORER_ROW_HEIGHT, getFileExplorerRowPadding } from './file-explorer-row-layout'

describe('compact file explorer rows', () => {
  it('shares the 22px row height and 12px indent across normal and editing rows', () => {
    expect(FILE_EXPLORER_ROW_HEIGHT).toBe(22)
    expect(getFileExplorerRowPadding(0)).toBe(8)
    expect(getFileExplorerRowPadding(1)).toBe(20)
    expect(getFileExplorerRowPadding(2)).toBe(32)
    expect(getFileExplorerRowPadding(-1)).toBe(8)
    const markup = renderToStaticMarkup(
      <InlineInputRow
        depth={2}
        inlineInput={{ parentPath: '/project', type: 'file', depth: 2 }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(markup).toContain('height:22px')
    expect(markup).toContain('padding-left:32px')
  })

  it('draws guides only for visible ancestors, using the border token', () => {
    expect(renderToStaticMarkup(<FileExplorerIndentGuides depth={0} />)).toBe('')
    const markup = renderToStaticMarkup(<FileExplorerIndentGuides depth={2} />)
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).toContain('width:24px')
    expect(markup).toContain('var(--border)')
  })

  it('preserves the folder icon while renaming a directory', () => {
    const markup = renderToStaticMarkup(
      <InlineInputRow
        depth={0}
        inlineInput={{
          parentPath: '/project',
          type: 'rename',
          depth: 0,
          existingName: '__fixtures__',
          isDirectory: true
        }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(markup).toContain(
      renderToStaticMarkup(
        <FolderIcon
          folderPath="__fixtures__"
          open={false}
          className="size-3 shrink-0 text-muted-foreground"
        />
      )
    )
  })
})
