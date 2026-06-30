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
    // Why: happy-dom does not resolve CSS variables at runtime, so we assert
    // against the token reference (see src/renderer/src/assets/main.css :root
    // for the actual color values). For the border shorthand we read the raw
    // style attribute because happy-dom's CSSOM strips the color sub-value
    // when parsing `border: 1px solid var(--token)`.
    expect(root.style.background).toBe('var(--color-warning-soft)')
    expect(root.getAttribute('style')).toContain('var(--color-warning-border)')
    expect(root.style.color).toBe('var(--color-warning-fg)')
  })

  it('uses red palette for non-SSH errors', () => {
    const { container } = render(
      <TerminalErrorBanner errors={[entry({ message: 'Daemon gone' })]} onDismiss={() => {}} />
    )
    const root = container.firstChild as HTMLElement
    // Why: happy-dom does not resolve CSS variables at runtime; assert the
    // token reference, not the computed rgba() value. Border uses
    // getAttribute('style') for the same CSSOM limitation as above.
    expect(root.style.background).toBe('var(--destructive-soft)')
    expect(root.getAttribute('style')).toContain('var(--destructive-border)')
    expect(root.style.color).toBe('var(--destructive-fg)')
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

describe('TerminalErrorBanner memo', () => {
  const baseProps = () => ({
    errors: [{ message: 'x', count: 1, lastSeenAt: 0 }],
    onDismiss: vi.fn()
  })

  it('skips re-render when the errors array reference is stable', () => {
    const props = baseProps()
    const { rerender, container } = render(<TerminalErrorBanner {...props} />)
    const firstNode = container.firstChild
    rerender(<TerminalErrorBanner {...props} />)
    // memo's default shallow comparator returns true for equal props; the fiber
    // (and thus the DOM node identity) is reused.
    expect(container.firstChild).toBe(firstNode)
  })

  it('re-renders when the errors array reference changes (count incremented)', () => {
    const props = baseProps()
    const { rerender, container } = render(<TerminalErrorBanner {...props} />)
    rerender(
      <TerminalErrorBanner {...props} errors={[{ message: 'x', count: 2, lastSeenAt: 0 }]} />
    )
    expect(container.textContent).toMatch(/×2/)
  })
})
