import { defineFixture } from '@/component-fixtures/component-fixture'

const ACCENT: React.CSSProperties & { '--text-link': string } = { '--text-link': '#cc1111' }

export const searchMatches = defineFixture({
  width: 420,
  render: () => (
    <div className="rich-markdown-editor-layout p-4 text-sm text-foreground" style={ACCENT}>
      <p>
        Search results: <span className="rich-markdown-search-match">inactive match</span> and{' '}
        <span className="rich-markdown-search-match" data-active="true">
          active match
        </span>
        .
      </p>
    </div>
  )
})

export const selectedText = defineFixture({
  width: 420,
  render: () => (
    <div className="rich-markdown-editor-layout p-4 text-sm text-foreground" style={ACCENT}>
      <p data-select>Select this sentence to see the theme accent.</p>
    </div>
  ),
  interact: (frame) => {
    const text = frame.querySelector<HTMLElement>('[data-select]')?.firstChild
    if (!text) {
      return
    }
    const range = document.createRange()
    range.selectNodeContents(text)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
})
