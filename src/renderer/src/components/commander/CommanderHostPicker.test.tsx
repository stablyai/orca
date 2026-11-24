// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { setBotHostListing } from '@/lib/bot-catalog-snapshot'
import { publicRuntimeEnvironment } from '@/runtime/rpc/testing/paired-runtime-environment-test-fixture'
import { CommanderHostPicker } from './CommanderHostPicker'
import { selectCommanderHost, selectedCommanderHost } from './selected-commander-host'

const local = { hostId: 'local', state: 'live' } as const
const office = { hostId: 'runtime:office', state: 'live' } as const

afterEach(() => {
  cleanup()
  selectCommanderHost('local')
  setBotHostListing({ hosts: [local], updateNeeded: [] })
  useAppStore.setState({ runtimeEnvironments: [] })
})

it('routes chat to the named host the owner selects and keeps a lost connection from switching destinations', async () => {
  useAppStore.setState({
    runtimeEnvironments: [publicRuntimeEnvironment({ id: 'office', name: 'Build Mac' })]
  })
  setBotHostListing({ hosts: [local, office], updateNeeded: [] })
  const user = userEvent.setup()
  render(<CommanderHostPicker />)
  const choose = screen.getByRole('combobox', { name: 'Commander host' })
  expect(selectedCommanderHost().target).toEqual({ kind: 'local' })
  await user.selectOptions(choose, screen.getByRole('option', { name: 'Build Mac' }))
  expect(choose).toHaveDisplayValue('Build Mac')
  expect(selectedCommanderHost().target).toEqual({ kind: 'environment', environmentId: 'office' })
  act(() => {
    setBotHostListing({ hosts: [local, { ...office, state: 'offline' }], updateNeeded: [] })
  })
  expect(choose).toHaveDisplayValue(/Build Mac.*Offline/)
  expect(() => selectedCommanderHost()).toThrow()
  await user.selectOptions(choose, 'local')
  expect(selectedCommanderHost().target).toEqual({ kind: 'local' })
  expect(screen.queryByRole('combobox', { name: 'Commander host' })).not.toBeInTheDocument()
})
