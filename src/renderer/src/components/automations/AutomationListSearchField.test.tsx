// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AutomationListSearchField } from './AutomationListSearchField'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('AutomationListSearchField', () => {
  it('autofocuses the search input on mount', () => {
    act(() => {
      root.render(
        <AutomationListSearchField
          query=""
          isTooLarge={false}
          onQueryChange={() => undefined}
          onClear={() => undefined}
        />
      )
    })

    const input = container.querySelector('input')
    expect(input).not.toBeNull()
    expect(document.activeElement).toBe(input)
  })
})
