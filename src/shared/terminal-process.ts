export type TerminalProcessExit = { exitCode: number; signal?: number }

/** The terminal engine contract consumed by the daemon and relay. */
export type TerminalProcess = {
  readonly pid: number
  readonly cols: number
  readonly rows: number
  readonly process: string
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: TerminalProcessExit) => void): { dispose(): void }
  write(data: string | Buffer): void
  resize(cols: number, rows: number): void
  clear(): void
  kill(signal?: string): void
  pause(): void
  resume(): void
}
