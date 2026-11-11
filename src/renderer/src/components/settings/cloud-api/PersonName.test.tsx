// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { PersonName, PersonSentence } from './PersonName'

afterEach(cleanup)

it('shows the display name only, never the raw id inline', () => {
  const { container } = render(<PersonName name="Grace Hopper" id="u_grace" />)
  expect(container.textContent).toBe('Grace Hopper')
  expect(container.querySelector('[title]')).toBeNull()
})

it('says "Former member" when nobody can name the person', () => {
  const { container } = render(<PersonName name="  " id="u_7f3k" />)
  expect(container.textContent).toBe('Former member')
  expect(container.innerHTML).not.toContain('u_7f3k')
})

it('keeps the id one hover away in the audit log only', () => {
  const { container } = render(
    <PersonSentence sentence="<person></person> via API key" name={null} id="u_7f3k" idInTooltip />
  )
  expect(container.textContent).toBe('Former member via API key')
  expect(container.querySelector('[title]')?.getAttribute('title')).toBe('u_7f3k')
})
