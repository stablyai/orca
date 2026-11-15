// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TerminalErrorToast } from './TerminalErrorToast'

const { FOOTER } = vi.hoisted(() => ({
  FOOTER: ['---', 'Orca: 1.4.200', 'OS: darwin 25.0.0 (arm64)', 'Shell: /bin/zsh'].join('\n')
}))

vi.mock('@/app-shell/platform/client-environment-info', () => ({
  resolveClientEnvironmentFooter: vi.fn().mockResolvedValue(FOOTER)
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('TerminalErrorToast copy button', () => {
  it('copies the error text with its environment footer', async () => {
    const writeClipboardText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('api', { ui: { writeClipboardText } })
    const error = 'Failed to spawn shell "/bin/zsh": posix_spawn failed (shell: /bin/zsh).'
    render(
      <TooltipProvider>
        <TerminalErrorToast error={error} onDismiss={vi.fn()} />
      </TooltipProvider>
    )
    await screen.findByText(/Orca: 1\.4\.200/)

    fireEvent.click(screen.getByRole('button', { name: 'Copy error details' }))

    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledWith(`${error}\n\n${FOOTER}`))
  })
})
