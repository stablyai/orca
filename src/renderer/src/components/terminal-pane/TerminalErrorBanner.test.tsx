/**
 * @vitest-environment happy-dom
 */
import { render, screen } from '@testing-library/react'
import { afterEach as afterEachVitest, describe, expect, it, vi } from 'vitest'
import { TerminalErrorBanner } from './TerminalErrorBanner'
import type { TerminalErrorEntry } from './use-terminal-error-table'
import { shouldOfferDaemonRestart } from './TerminalErrorBanner'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

afterEachVitest(() => {
  document.body.innerHTML = ''
})

const entry = (overrides: Partial<TerminalErrorEntry> = {}): TerminalErrorEntry => ({
  message: 'Daemon error',
  count: 1,
  lastSeenAt: 0,
  ...overrides
})

describe('shouldOfferDaemonRestart', () => {
  it('matches stale daemon node-pty install failures', () => {
    expect(
      shouldOfferDaemonRestart([
        "Daemon's node-pty install is gone (worktree deleted?). Restart Orca. node-pty: posix_spawn failed: ENOENT (errno 2, No such file or directory) - helper='/Applications/Orca.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper'"
      ])
    ).toBe(true)
  })

  it('matches stale daemon cwd failures', () => {
    expect(
      shouldOfferDaemonRestart([
        "Daemon's working directory is gone (worktree deleted?). Restart Orca. node-pty: daemon_cwd failed: ENOENT (errno 2, No such file or directory) - cwd='<unavailable>'"
      ])
    ).toBe(true)
  })

  it('does not match unrelated terminal spawn errors', () => {
    expect(shouldOfferDaemonRestart(['SSH connection is not active.'])).toBe(false)
    expect(shouldOfferDaemonRestart(['node-pty: open_slave failed: EMFILE (errno 24)'])).toBe(false)
  })
})

describe('TerminalErrorBanner render', () => {
  it('shows the count badge for repeated errors', () => {
    render(<TerminalErrorBanner errors={[entry({ count: 7 })]} onDismiss={() => {}} />)
    expect(screen.getByText(/Daemon error\s*\(×7\)/)).toBeTruthy()
  })

  it('omits the count badge for first-occurrence errors', () => {
    render(
      <TerminalErrorBanner
        errors={[entry({ count: 1, message: 'one-shot failure' })]}
        onDismiss={() => {}}
      />
    )
    expect(screen.queryByText(/×1/)).toBeNull()
  })

  it('uses yellow palette for SSH-prefixed errors', () => {
    const { container } = render(
      <TerminalErrorBanner
        errors={[entry({ message: 'SSH connection is not active.' })]}
        onDismiss={() => {}}
      />
    )
    const root = container.firstChild as HTMLElement
    expect(root.style.background).toContain('rgba(234, 179, 8, 0.12)')
    expect(root.style.border).toContain('rgba(234, 179, 8, 0.35)')
    expect(root.style.color).toBe('#fde68a')
  })

  it('uses red palette for non-SSH errors', () => {
    const { container } = render(
      <TerminalErrorBanner errors={[entry({ message: 'Daemon gone' })]} onDismiss={() => {}} />
    )
    const root = container.firstChild as HTMLElement
    expect(root.style.background).toContain('rgba(220, 38, 38, 0.15)')
    expect(root.style.color).toBe('#fca5a5')
  })

  it('hides the daemon restart button for SSH errors', () => {
    render(
      <TerminalErrorBanner
        errors={[entry({ message: 'SSH connection is not active.' })]}
        onDismiss={() => {}}
        onRestartDaemon={() => {}}
      />
    )
    expect(screen.queryByText('Restart daemon')).toBeNull()
  })

  it('shows the daemon restart button for stale daemon markers', () => {
    render(
      <TerminalErrorBanner
        errors={[
          entry({
            message:
              "Daemon's node-pty install is gone (worktree deleted?). Restart Orca. node-pty: posix_spawn failed: ENOENT"
          })
        ]}
        onDismiss={() => {}}
        onRestartDaemon={() => {}}
      />
    )
    expect(screen.getByText('Restart daemon')).toBeTruthy()
  })

  it('renders the file-an-issue link for non-daemon, non-SSH errors', () => {
    render(
      <TerminalErrorBanner errors={[entry({ message: 'Plain error' })]} onDismiss={() => {}} />
    )
    const link = screen.getByRole('link', { name: /file an issue/i })
    expect(link.getAttribute('href')).toBe('https://github.com/stablyai/orca/issues')
  })

  it('renders multiple entries when supplied', () => {
    render(
      <TerminalErrorBanner
        errors={[entry({ message: 'first' }), entry({ message: 'second', count: 3 })]}
        onDismiss={() => {}}
      />
    )
    expect(screen.getByText(/^first$/)).toBeTruthy()
    expect(screen.getByText(/second\s*\(×3\)/)).toBeTruthy()
  })
})
