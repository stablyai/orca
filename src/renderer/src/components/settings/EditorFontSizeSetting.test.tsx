// @vitest-environment happy-dom

import { join } from 'node:path'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'

const search = vi.hoisted((): { query: string } => ({ query: '' }))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: search.query })
}))

import { EditorFontSizeSetting } from './EditorFontSizeSetting'
import { getEditorFontSizeSearchEntry } from './general-editor-search'

afterEach(() => {
  cleanup()
  search.query = ''
})

function renderSetting(editorFontSize: number | undefined, updateSettings = vi.fn()) {
  const { getByLabelText } = render(
    <EditorFontSizeSetting
      settings={{
        ...getDefaultSettings(join('test', 'home')),
        terminalFontSize: 13,
        editorFontSize
      }}
      updateSettings={updateSettings}
    />
  )
  const input = getByLabelText('Editor Font Size')
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('Expected the Editor Font Size field to be an input')
  }
  return { input, updateSettings }
}

function commit(input: HTMLInputElement, value: string): void {
  fireEvent.change(input, { target: { value } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

describe('EditorFontSizeSetting', () => {
  it('shows an empty field with the followed terminal size when unset', () => {
    const { input } = renderSetting(undefined)

    expect(input.value).toBe('')
    expect(input.placeholder).toBe('13')
  })

  it('shows the saved editor font size', () => {
    const { input } = renderSetting(18)

    expect(input.value).toBe('18')
  })

  it('persists a typed editor font size', () => {
    const { input, updateSettings } = renderSetting(undefined)

    commit(input, '18')

    expect(updateSettings).toHaveBeenCalledWith({ editorFontSize: 18 })
  })

  it('clamps a typed size to the 10-24 px range', () => {
    const { input, updateSettings } = renderSetting(undefined)

    commit(input, '40')
    commit(input, '4')

    expect(updateSettings).toHaveBeenNthCalledWith(1, { editorFontSize: 24 })
    expect(updateSettings).toHaveBeenNthCalledWith(2, { editorFontSize: 10 })
  })

  it('clears the setting when the field is emptied so the editor follows the terminal again', () => {
    const { input, updateSettings } = renderSetting(18)

    commit(input, '')

    expect(updateSettings).toHaveBeenCalledWith({ editorFontSize: undefined })
  })

  it.each(getEditorFontSizeSearchEntry().keywords)(
    'stays visible for the search keyword "%s" that opens its section',
    (keyword) => {
      search.query = keyword

      expect(() => renderSetting(undefined)).not.toThrow()
    }
  )
})
