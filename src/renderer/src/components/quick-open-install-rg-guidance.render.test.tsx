// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { QuickOpenInstallRgGuidance } from './quick-open-install-rg-guidance'

afterEach(cleanup)

describe('QuickOpenInstallRgGuidance', () => {
  it('says the local host, not the remote, for a local scan', () => {
    render(
      <QuickOpenInstallRgGuidance
        reason="File listing timed out"
        location="local"
        command="brew install ripgrep"
        guidance={null}
      />
    )
    expect(screen.getByText(/on the host running the Quick Open scan/i)).toBeTruthy()
    expect(screen.queryByText(/on the remote/i)).toBeNull()
  })

  it('says the remote for a relay scan', () => {
    render(
      <QuickOpenInstallRgGuidance
        reason="File listing exceeded 10000 files"
        location="remote"
        command="sudo apt install ripgrep"
        guidance={null}
      />
    )
    expect(screen.getByText(/on the remote to enable fast/i)).toBeTruthy()
  })
})
