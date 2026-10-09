import { existsSync } from 'node:fs'

/**
 * Busy-wait past `minMs` and until the child wrote `marker` just before exiting.
 * Models a synchronous main-thread freeze that a child finishes inside of.
 */
export function blockEventLoopUntilChildFinished(marker: string, minMs: number): void {
  const start = Date.now()
  while (Date.now() - start < minMs || (!existsSync(marker) && Date.now() - start < 10_000)) {
    // Spin.
  }
  // Margin for the child to exit after writing the marker.
  const exitMargin = Date.now() + 200
  while (Date.now() < exitMargin) {
    // Spin.
  }
}

/** A `node -e` script that writes `marker` and then prints `stdout`. */
export function finishingChildScript(marker: string, stdout: string): string {
  return `require("node:fs").writeFileSync(${JSON.stringify(marker)}, ""); process.stdout.write(${JSON.stringify(stdout)})`
}
