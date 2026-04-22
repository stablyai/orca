/**
 * Simulates Ink's (React for CLI) inline viewport rendering behavior.
 *
 * Ink renders inline in the normal terminal buffer (not the alt screen).
 * On SIGWINCH it re-renders by:
 *   1. Moving cursor up to the start of the previous render
 *   2. Clearing from cursor to end of display (\033[J)
 *   3. Writing the new rendered output
 *
 * This is the exact pattern that causes scroll position corruption during
 * divider drag resize, because the clear + rewrite sequence moves xterm.js's
 * viewportY when the terminal has scrollback content above the render area.
 *
 * Usage: node tests/e2e/fixtures/ink-tui-sim.mjs
 * Exits cleanly on SIGTERM or SIGINT.
 */

const TUI_HEIGHT = 12

let lastLineCount = 0

function render() {
  const { columns: cols, rows } = process.stdout

  // Step 1: if we previously rendered, move cursor back to start of that render
  if (lastLineCount > 0) {
    process.stdout.write(`\x1b[${lastLineCount}A\r`)
  }

  // Step 2: clear from cursor to end of display (exactly what Ink does)
  process.stdout.write('\x1b[J')

  // Step 3: write the TUI content
  const lines = []
  const hr = '━'.repeat(Math.min(cols, 80))
  lines.push(`\x1b[1m${hr}\x1b[0m`)
  lines.push(`  \x1b[36m◆\x1b[0m Claude Code  \x1b[2mv2.1.10\x1b[0m`)
  lines.push(`  \x1b[2mModel: claude-sonnet-4-20250514\x1b[0m`)
  lines.push('')
  lines.push(`  \x1b[33m⠋\x1b[0m Thinking...`)
  lines.push('')

  // Fill remaining TUI height with status lines
  const used = lines.length
  for (let i = used; i < TUI_HEIGHT - 2; i++) {
    const pad = ' '.repeat(Math.max(0, Math.min(cols, 80) - 30))
    lines.push(`  \x1b[2mcontext: ${cols}×${rows} │ tokens: ${1234 + i}${pad}\x1b[0m`)
  }

  lines.push(`\x1b[1m${hr}\x1b[0m`)
  lines.push(
    `\x1b[7m ${' '.repeat(Math.max(0, Math.min(cols, 80) - 22))}` +
      `${cols}×${rows} | Ctrl+C to exit \x1b[0m`
  )

  const output = lines.join('\n') + '\n'
  process.stdout.write(output)
  lastLineCount = lines.length
}

// Initial render
render()

// Re-render on SIGWINCH (terminal resize) — this is the critical behavior
process.on('SIGWINCH', render)

// Clean exit
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))

// Keep alive
setInterval(() => {}, 60_000)
