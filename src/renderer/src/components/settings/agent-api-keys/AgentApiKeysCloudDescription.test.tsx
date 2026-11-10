// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentApiKeysCloudDescription } from './AgentApiKeysCloudDescription'

describe('AgentApiKeysCloudDescription', () => {
  afterEach(cleanup)

  it('says the keys are not for Orca Cloud and links to Cloud secrets', () => {
    const open = vi.fn()
    const { container } = render(<AgentApiKeysCloudDescription onOpenCloudSecrets={open} />)
    expect(container.textContent).toBe(
      'Keys here are for this computer and your SSH and paired hosts. For Orca Cloud, use Cloud secrets.'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cloud secrets' }))
    expect(open).toHaveBeenCalledTimes(1)
  })
})
