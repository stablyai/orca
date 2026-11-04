// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { PendingWorktreeRow } from './PendingWorktreeRow'

describe('PendingWorktreeRow', () => {
  afterEach(cleanup)

  it('draws a creation this host runs for a phone or the CLI, which the window holds no request for', () => {
    const { container } = render(<PendingWorktreeRow creationId="from-phone" repoName="orca" />)
    expect(container.textContent).toBe('Creating workspace…orca')
    expect(container.querySelector('button')).toBeNull()
  })
})
