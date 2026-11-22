// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

const host = vi.hoisted((): { stored: string; writes: string[] } => ({
  stored: 'auto',
  writes: []
}))
vi.mock('../settings/host-scope/use-host-setting', () => ({
  useHostSetting: () => ({
    setting: { state: 'ready', value: host.stored },
    update: async (value: string) => {
      host.writes.push(value)
    }
  })
}))

import { AntigravityGoogleSignInChoice } from './AntigravityGoogleSignInChoice'

afterEach(() => {
  cleanup()
  host.writes = []
})

const local: { kind: 'local' } = { kind: 'local' }

it('labels the sign-in in use while nothing is picked', () => {
  host.stored = 'auto'
  render(<AntigravityGoogleSignInChoice owner={local} inUse="orca" changed={() => {}} />)
  expect(screen.getByRole('combobox')).toHaveTextContent("Orca's built-in sign-in")
})

it("saves a pick of the label shown when what is stored differs, so a stored agy that can't apply is replaceable", async () => {
  // agy is stored, but chats run on Orca's server (Orca's agy off, agy signed out).
  host.stored = 'agy'
  const changed = vi.fn()
  render(<AntigravityGoogleSignInChoice owner={local} inUse="orca" changed={changed} />)
  expect(screen.getByRole('combobox')).toHaveTextContent("Orca's built-in sign-in")
  const user = userEvent.setup()
  await user.click(screen.getByRole('combobox'))
  await user.click(await screen.findByRole('option', { name: /Orca's built-in sign-in/ }))
  await waitFor(() => expect(host.writes).toEqual(['orca']))
  expect(changed).toHaveBeenCalled()
})
