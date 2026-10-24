import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { EditorFileCenteredLayout } from './EditorFileCenteredLayout'

describe('EditorFileCenteredLayout', () => {
  it('keeps a stable full-width shell when the preference is off', () => {
    const html = renderToStaticMarkup(
      <EditorFileCenteredLayout enabled={false}>
        <div data-editor-surface="code" />
      </EditorFileCenteredLayout>
    )

    expect(html).toContain('data-editor-surface="code"')
    expect(html).not.toContain('data-editor-centered-layout')
    expect(html).not.toContain('justify-center')
    expect(html).not.toContain('max-w-4xl')
    expect(html.startsWith('<div class="h-full min-h-0 w-full"')).toBe(true)
  })

  it('wraps children in a centered max-width column when enabled', () => {
    const html = renderToStaticMarkup(
      <EditorFileCenteredLayout enabled>
        <div data-editor-surface="code" />
      </EditorFileCenteredLayout>
    )

    expect(html).toContain('data-editor-centered-layout="true"')
    expect(html).toContain('justify-center')
    expect(html).toContain('max-w-4xl')
    expect(html).toContain('data-editor-surface="code"')
  })
})
