// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { WslDistroStoppedHoldCard } from './WslDistroStoppedHoldCard'
import {
  holdPaneForStoppedWslDistro,
  wslDistroStoppedHoldStore
} from './wsl-distro-stopped-hold-state'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => options?.[name] ?? ''),
  getIntlLocale: () => 'en-US'
}))

const TAB = '11111111-1111-4111-8111-111111111111'
const LEAF = '22222222-2222-4222-8222-222222222222'

afterEach(() => {
  cleanup()
  wslDistroStoppedHoldStore.setState({ panes: {} })
})

function holdPane(state: 'stopped' | 'unverifiable') {
  const release = vi.fn(async () => {})
  holdPaneForStoppedWslDistro(makePaneKey(TAB, LEAF), { distro: 'Ubuntu', state, release })
  render(<WslDistroStoppedHoldCard tabId={TAB} leafId={LEAF} />)
  return release
}

describe('a restored WSL bridge pane held for its distro (E9)', () => {
  it('says the distro is stopped when the read found it stopped', () => {
    holdPane('stopped')
    expect(screen.getByText('Ubuntu is stopped')).toBeInTheDocument()
  })

  // The read gave no answer, so the card must not claim the distro stopped.
  it("says Orca couldn't check when the read could not tell, and still offers Start", async () => {
    const release = holdPane('unverifiable')
    expect(screen.getByText("Orca couldn't check whether Ubuntu is running")).toBeInTheDocument()
    expect(screen.queryByText('Ubuntu is stopped')).not.toBeInTheDocument()

    await userEvent.setup().click(screen.getByRole('button', { name: 'Start' }))
    expect(release).toHaveBeenCalledOnce()
  })
})
