/** Hints a CLI caller sends so `--current` resolves the worktree it runs in. */
export type CurrentWorktreeContextHints = {
  worktreeId?: string
  terminalHandle?: string
  cwd?: string
  remote?: boolean
}
