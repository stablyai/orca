// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { getAgentAwakeTitle } from '../settings/agent-awake-copy'
import { KeepAwakeCard } from './KeepAwakeCard'

afterEach(cleanup)

describe('KeepAwakeCard', () => {
  it('enables automatic keep-awake mode from off', () => {
    const updateSettings = vi.fn()

    render(
      <KeepAwakeCard
        settings={{
          ...getDefaultSettings('/tmp'),
          computerAwakeMode: 'off',
          keepComputerAwakeWhileAgentsRun: false
        }}
        updateSettings={updateSettings}
      />
    )

    fireEvent.click(screen.getByRole('switch', { name: getAgentAwakeTitle() }))

    expect(updateSettings).toHaveBeenCalledWith({
      computerAwakeMode: 'auto',
      keepComputerAwakeWhileAgentsRun: true
    })
  })

  it('disables either enabled mode', () => {
    const updateSettings = vi.fn()

    render(
      <KeepAwakeCard
        settings={{
          ...getDefaultSettings('/tmp'),
          computerAwakeMode: 'on',
          keepComputerAwakeWhileAgentsRun: true
        }}
        updateSettings={updateSettings}
      />
    )

    fireEvent.click(screen.getByRole('switch', { name: getAgentAwakeTitle() }))

    expect(updateSettings).toHaveBeenCalledWith({
      computerAwakeMode: 'off',
      keepComputerAwakeWhileAgentsRun: false
    })
  })
})
