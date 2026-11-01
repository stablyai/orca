// Keep alternate-screen owners alive until assertions finish; prompt recovery discards frames from dead TUIs.

/** Node statement that keeps a fixture — and so its alternate screen — the live PTY foreground. */
export const HOLD_ALTERNATE_SCREEN_OPEN = 'setInterval(() => {}, 1000)'

/** Fixture program: paint `payload`, then stay the live alternate-screen owner. */
export function alternateScreenFixtureScript(payload: string, delayMs = 0): string {
  const write = `process.stdout.write(${JSON.stringify(payload)})`
  const paint = delayMs > 0 ? `setTimeout(() => ${write}, ${delayMs})` : write
  return `${paint}\n${HOLD_ALTERNATE_SCREEN_OPEN}\n`
}
