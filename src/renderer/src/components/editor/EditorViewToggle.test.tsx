import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import EditorViewToggle, { CUSTOM_EDITOR_SOURCE_METADATA } from './EditorViewToggle'

const PLUGIN_VALUE = 'plugin-editor:kolebayev.md-layout/narrow' as const
const ICON_URL = `orca-plugin-image://installed/kolebayev.md-layout/${'a'.repeat(64)}/editor-0`

function render(iconUrl?: string): string {
  return renderToStaticMarkup(
    <EditorViewToggle
      value="source"
      modes={[PLUGIN_VALUE, 'source', 'rich', 'changes']}
      onChange={() => {}}
      metadataOverride={CUSTOM_EDITOR_SOURCE_METADATA}
      customEditorOptions={{
        [PLUGIN_VALUE]: {
          title: '<b>Narrow</b>',
          pluginName: 'Markdown Layout',
          ...(iconUrl ? { iconUrl } : {})
        }
      }}
    />
  )
}

describe('EditorViewToggle plugin editors', () => {
  it('labels a plugin view with its name as plain text', () => {
    const html = render()
    const item = html.slice(html.indexOf('data-plugin-editor-label'))
    expect(item).toContain('&lt;b&gt;Narrow&lt;/b&gt;</span>')
    expect(html).toContain('aria-label="&lt;b&gt;Narrow&lt;/b&gt;"')
    expect(html).not.toContain('<b>')
  })

  it('keeps built-in views icon-only', () => {
    const html = render()
    expect(html.match(/data-plugin-editor-label/g)).toHaveLength(1)
    expect(html).toContain('aria-label="Rich Editor"')
    expect(html).not.toContain('>Rich Editor<')
  })

  it('uses the declared plugin icon, else the generic editor icon', () => {
    expect(render()).not.toContain('<img')
    expect(render(ICON_URL)).toContain(`src="${ICON_URL}"`)
  })
})
