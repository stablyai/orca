import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { TerminalRichInputFileMenu } from './TerminalRichInputFileMenu'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/lib/file-type-icons', () => ({
  getFileTypeIcon: () => () => null
}))

describe('TerminalRichInputFileMenu', () => {
  it('connects the listbox and active shadcn option with stable IDs', () => {
    const html = renderToStaticMarkup(
      <TerminalRichInputFileMenu
        id="file-menu"
        loading={false}
        error={null}
        paths={['src/index.ts', 'README.md']}
        activeIndex={1}
        onChoose={() => {}}
      />
    )

    expect(html).toContain('id="file-menu"')
    expect(html).toContain('role="listbox"')
    expect(html).toContain('id="file-menu-option-1"')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('data-slot="button"')
  })
})
