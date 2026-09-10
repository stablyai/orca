// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { clearMaestroWorkspaceCanvasFocus } from './useMaestroWorkspaceSelection'

describe('MaestroWorkspaceCanvas background interaction', () => {
  afterEach(cleanup)

  it('blurs the active terminal input when the empty canvas takes interaction', () => {
    render(<textarea aria-label="Terminal input" />)
    const terminalInput = screen.getByRole('textbox', { name: 'Terminal input' })
    terminalInput.focus()
    expect(document.activeElement).toBe(terminalInput)

    clearMaestroWorkspaceCanvasFocus()

    expect(document.activeElement).not.toBe(terminalInput)
  })
})
