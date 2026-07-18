// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebAiAccountDialog } from './WebAiAccountDialog'

afterEach(cleanup)

function renderDialog() {
  const onSubmit = vi.fn()
  const user = userEvent.setup()
  render(
    <WebAiAccountDialog
      open
      onOpenChange={vi.fn()}
      profiles={[]}
      submitting={false}
      onSubmit={onSubmit}
    />
  )
  return { user, onSubmit }
}

async function selectProvider(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getAllByRole('combobox')[0])
  await user.click(screen.getByRole('option', { name: label }))
}

describe('WebAiAccountDialog', () => {
  it('offers Google AI Studio with the shared Google cookie warning', async () => {
    const { user } = renderDialog()

    expect(screen.queryByText(/shared google\.com sign-in cookies/i)).not.toBeInTheDocument()

    await selectProvider(user, 'Google AI Studio')

    expect(
      screen.getByText(/Google AI Studio uses shared google\.com sign-in cookies/i)
    ).toBeVisible()

    await selectProvider(user, 'Gemini')

    expect(screen.getByText(/Gemini uses shared google\.com sign-in cookies/i)).toBeVisible()
  })

  it('labels the shared Google warning for a Custom service', async () => {
    const { user } = renderDialog()
    await selectProvider(user, 'Custom')
    await user.type(screen.getByLabelText('Service name'), 'Internal AI')
    await user.type(screen.getByLabelText('Home URL'), 'https://chat.example.google.com/')
    await user.type(screen.getByLabelText('Cookie domains'), 'google.com')

    expect(screen.getByText(/Internal AI uses shared google\.com sign-in cookies/i)).toBeVisible()
    expect(screen.queryByText(/Google AI Studio and Gemini/i)).not.toBeInTheDocument()
  })

  it('builds a normalized Doubao Custom draft with a derived cookie domain', async () => {
    const { user, onSubmit } = renderDialog()
    await selectProvider(user, 'Custom')

    await user.type(screen.getByLabelText('Service name'), 'Doubao')
    await user.type(screen.getByLabelText('Home URL'), 'https://www.doubao.com/chat/')

    expect(screen.getByLabelText('Account name')).toHaveValue('Doubao')
    expect(screen.getByText(/Leave blank to use doubao\.com/i)).toBeVisible()
    expect(screen.queryByText(/shared google\.com sign-in cookies/i)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add and open' }))

    expect(onSubmit).toHaveBeenCalledWith({
      provider: 'custom',
      label: 'Doubao',
      profileId: null,
      customServiceLabel: 'Doubao',
      customHomeUrl: 'https://www.doubao.com/chat/',
      customCookieDomains: ['doubao.com']
    })
  })

  it('keeps the Custom service label when switching away and back', async () => {
    const { user } = renderDialog()
    await selectProvider(user, 'Custom')
    await user.type(screen.getByLabelText('Service name'), 'Doubao')

    await selectProvider(user, 'ChatGPT')
    await selectProvider(user, 'Custom')

    expect(screen.getByLabelText('Account name')).toHaveValue('Doubao')
  })

  it('rejects URL credentials and unrelated cookie domains', async () => {
    const { user, onSubmit } = renderDialog()
    await selectProvider(user, 'Custom')
    await user.type(screen.getByLabelText('Service name'), 'Doubao')
    await user.type(screen.getByLabelText('Home URL'), 'https://user:secret@www.doubao.com/')

    expect(screen.getByLabelText('Home URL')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('button', { name: 'Add and open' })).toBeDisabled()

    await user.clear(screen.getByLabelText('Home URL'))
    await user.type(screen.getByLabelText('Home URL'), 'https://www.doubao.com/')
    await user.type(screen.getByLabelText('Cookie domains'), 'google.com')

    expect(screen.getByLabelText('Cookie domains')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('button', { name: 'Add and open' })).toBeDisabled()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
