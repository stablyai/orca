// The refusal a runtime call meets when its WSL host's distro was stopped; the renderer clears it once the host returns.
export function wslHostStoppedMessage(distro: string): string {
  return `${distro} is stopped. To start it, click Start or open a new terminal in one of its projects.`
}

/** True for an error line carrying this distro's refusal, with or without an IPC wrapper around it. */
export function isWslHostStoppedErrorLine(line: string, distro: string): boolean {
  return line.includes(wslHostStoppedMessage(distro))
}

/** The error without the distro's refusal lines; null when nothing else was on it. */
export function withoutWslHostStoppedLines(error: string, distro: string): string | null {
  const kept = error
    .split('\n')
    .filter((line) => !isWslHostStoppedErrorLine(line, distro))
    .join('\n')
  return kept.length > 0 ? kept : null
}
