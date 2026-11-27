// @vitest-environment happy-dom
import { act } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import { NativeChatComposerDetails } from './NativeChatComposerDetails'

vi.mock('./NativeChatComposerWorkspace', () => ({
  NativeChatComposerWorkspace: () => <div data-testid="composer-details-row" />
}))

function setComposerDetails(on: boolean): void {
  act(() =>
    useAppStore.setState({
      settings: { ...getDefaultSettings('/home/me'), nativeChatComposerDetails: on }
    })
  )
}

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('composer details row', () => {
  it('renders nothing while the setting is off and the row once it is on', () => {
    setComposerDetails(false)
    render(<NativeChatComposerDetails terminalTabId="tab-1" />)
    expect(screen.queryByTestId('composer-details-row')).toBeNull()

    setComposerDetails(true)
    expect(screen.getByTestId('composer-details-row')).toBeTruthy()

    setComposerDetails(false)
    expect(screen.queryByTestId('composer-details-row')).toBeNull()
  })
})
