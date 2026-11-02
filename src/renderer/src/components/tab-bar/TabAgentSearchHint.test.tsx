// @vitest-environment happy-dom
import type { FormEvent } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TabAgentSearchHint } from './TabAgentSearchHint'

afterEach(cleanup)

it('offers both model examples and dismissal without submitting the search form', () => {
  const onTry = vi.fn()
  const onDismiss = vi.fn()
  const onSubmit = vi.fn((event: FormEvent) => event.preventDefault())
  const view = render(
    <form onSubmit={onSubmit}>
      <TabAgentSearchHint
        examples={['Opus (1M context)', '6.1-terra']}
        onTry={onTry}
        onDismiss={onDismiss}
      />
    </form>
  )

  fireEvent.click(view.getByRole('button', { name: 'Try “Opus (1M context)”' }))
  fireEvent.click(view.getByRole('button', { name: 'Try “6.1-terra”' }))
  expect(onTry.mock.calls).toEqual([['Opus (1M context)'], ['6.1-terra']])
  expect(onDismiss).not.toHaveBeenCalled()

  fireEvent.click(view.getByRole('button', { name: 'Dismiss agent search hint' }))
  expect(onDismiss).toHaveBeenCalledOnce()
  expect(onSubmit).not.toHaveBeenCalled()
})
