import { act, fireEvent, render, within } from '@testing-library/react'
import { toast } from 'sonner'
import { vi } from 'vitest'

export function permissionNotice() {
  const options = vi.mocked(toast.success).mock.calls.at(-1)?.[1]
  const action = options?.action
  if (
    !action ||
    typeof action !== 'object' ||
    !('onClick' in action) ||
    typeof action.onClick !== 'function'
  ) {
    throw new Error('Missing follow action')
  }
  const description = options?.description
  const details = render(typeof description === 'function' ? description() : description)
  const button = render(<button onClick={action.onClick}>Follow notice</button>)
  return {
    options,
    details: details.container,
    follow: async () => {
      await act(async () => {
        fireEvent.click(within(button.container).getByRole('button', { name: 'Follow notice' }))
      })
    }
  }
}
