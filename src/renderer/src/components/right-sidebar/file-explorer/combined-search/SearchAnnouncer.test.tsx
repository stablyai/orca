// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { SearchAnnouncer } from './SearchAnnouncer'

afterEach(cleanup)

describe('SearchAnnouncer', () => {
  it('mounts its live region empty and fills it after mount', () => {
    // A region that already holds text when it appears is not announced (a restored draft's notice).
    expect(renderToStaticMarkup(<SearchAnnouncer text="Not available here" />)).not.toContain(
      'Not available here'
    )
    const { container } = render(<SearchAnnouncer text="Not available here" />)
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Not available here')
  })
})
