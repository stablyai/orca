// Why an alternate-screen fixture must outlive the assertions that read it:
// main's dead-TUI recovery barrier (src/main/daemon/terminal-shell-recovery-barrier.ts)
// injects `\x1b[?1049l` as soon as a shell prompt proves an alternate-screen owner
// exited without its own cleanup, so a fixture that paints and exits has its frames
// discarded before a spec can observe them. Specs Ctrl-C them once done reading.

/** Node statement that keeps a fixture — and so its alternate screen — the live PTY foreground. */
export const HOLD_ALTERNATE_SCREEN_OPEN = 'setInterval(() => {}, 1000)'

/** Fixture program: paint `payload`, then stay the live alternate-screen owner. */
export function alternateScreenFixtureScript(payload: string, delayMs = 0): string {
  const write = `process.stdout.write(${JSON.stringify(payload)})`
  const paint = delayMs > 0 ? `setTimeout(() => ${write}, ${delayMs})` : write
  return `${paint}\n${HOLD_ALTERNATE_SCREEN_OPEN}\n`
}
