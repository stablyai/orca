// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { NativeChatMarkdown } from './NativeChatMarkdown'

afterEach(cleanup)

it('keeps the number typed on each ordered list item', () => {
  const { container } = render(
    <NativeChatMarkdown
      content={'1. first\n2. second\n4. fourth\n\n> 7. quoted\n> 9. skip'}
      variant="document"
    />
  )
  const numbers = [...container.querySelectorAll('li')].map((li) => li.getAttribute('value'))
  expect(numbers).toEqual(['1', '2', '4', '7', '9'])
})
