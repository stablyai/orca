// The refusal a runtime call meets when its WSL host's distro was stopped; the renderer clears it once the host returns.
const WSL_HOST_STOPPED_SUFFIX =
  ' is stopped. To start it, click Start or open a new terminal in one of its projects.'

export function wslHostStoppedMessage(distro: string): string {
  return `${distro}${WSL_HOST_STOPPED_SUFFIX}`
}

/** True for an error line carrying that refusal, with or without an IPC wrapper around it. */
export function isWslHostStoppedErrorLine(line: string): boolean {
  return line.includes(WSL_HOST_STOPPED_SUFFIX)
}
