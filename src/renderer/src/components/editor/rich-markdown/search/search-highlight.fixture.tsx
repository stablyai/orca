import { defineFixture } from '@/component-fixtures/component-fixture'

const useRedAccent = (): void => {
  document.documentElement.style.setProperty('--text-link', '#cc1111')
}

export const searchMatches = defineFixture({
  width: 420,
  setup: useRedAccent,
  render: () => (
    <div className="rich-markdown-editor-layout p-4 text-sm text-foreground">
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
  setup: useRedAccent,
  render: () => (
    <div className="rich-markdown-editor-layout p-4 text-sm text-foreground">
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
