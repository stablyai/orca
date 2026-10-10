// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { QuickOpenInstallRgGuidance } from './quick-open-install-rg-guidance'

afterEach(cleanup)

describe('QuickOpenInstallRgGuidance', () => {
  // Why only the remote wording: the local side always has Orca's bundled rg, so this guidance
  // can only ever describe a remote host that never received the upload.
  it('names the remote as the host to install ripgrep on', () => {
    render(
      <QuickOpenInstallRgGuidance
        reason="File listing exceeded 10000 files"
        command="sudo apt install ripgrep"
        guidance={null}
      />
    )
    expect(screen.getByText(/on the remote to enable fast/i)).toBeTruthy()
    expect(screen.queryByText(/on the host running the Quick Open scan/i)).toBeNull()
  })
})
