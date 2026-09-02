/** Identity of the shell process that owns a WSL PTY. */
export type WslShellProcessAnchor = {
  distro: string
  bootId: string
  shellPid: number
  shellStartTime: number
  tty: string
}
