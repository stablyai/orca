/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import type { Repo } from '../../../../../shared/repo-types'
import HiddenProjectsSection from './HiddenProjectsSection'

vi.mock('@/runtime/hosts/display/execution-host-display-label', () => ({
  selectExecutionHostDisplayLabel: (_state: unknown, hostId: string) => `host ${hostId}`
}))

const initialState = useAppStore.getState()

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
  useAppStore.setState(initialState, true)
})

describe('HiddenProjectsSection', () => {
  it('lists paired-server twins as separate rows, each Show naming its host', () => {
    // Twins share id and runtime host, differing only by the SSH target behind it.
    const twin: Repo = {
      ...TEST_REPO,
      id: 'r',
      displayName: 'api',
      executionHostId: 'runtime:env'
    }
    useAppStore.setState({
      repos: [
        { ...twin, connectionId: 'a', hiddenAt: 2 },
        { ...twin, connectionId: 'b', hiddenAt: 1 }
      ]
    })

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<HiddenProjectsSection />)
    fireEvent.click(screen.getByRole('button', { name: /Hidden projects \(2\)/ }))

    expect(screen.getAllByTestId('hidden-project')).toHaveLength(2)
    expect(
      screen.getAllByRole('button', { name: 'Show api on host runtime:env in the sidebar' })
    ).toHaveLength(2)
    // A shared React key would make updates drop or duplicate one twin.
    expect(consoleError.mock.calls.flat().join(' ')).not.toMatch(/same key/)
  })
})
