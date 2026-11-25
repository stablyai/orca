/** Runs a chat code block in a background terminal and reads its output back for the chat to show under it. */
import type { RuntimeTerminalRead } from './terminal/runtime/runtime-terminal-contracts'

export type CodeBlockRunCall = <T>(method: string, params: unknown) => Promise<T>

export type CodeBlockRunState =
  | { status: 'running'; output: string }
  | { status: 'done'; output: string; exitCode: number }
  | { status: 'failed'; output: string; reason: 'closed' | 'timeout' | 'error'; message?: string }

/** What a chat hands its code blocks: run `script`, reporting each new read of its output. */
export type CodeBlockScriptRunner = (
  script: string,
  onUpdate: (state: CodeBlockRunState) => void
) => Promise<void>

const DONE_MARK = '__orca_code_block_done_'
const DONE_LINE = new RegExp(`${DONE_MARK}(\\d+)__`)
const POLL_MS = 500
const TIMEOUT_MS = 5 * 60_000

/** The script plus a last line that prints its exit status, so a read can tell it finished. */
export function codeBlockRunCommand(script: string): string {
  return `${script}\nprintf '\\n${DONE_MARK}%s__\\n' "$?"`
}

/** The terminal's lines up to the done mark, without the mark's own echo; exitCode once it printed. */
export function codeBlockRunOutput(lines: readonly string[]): {
  output: string
  exitCode: number | null
} {
  const doneAt = lines.findIndex((line) => DONE_LINE.test(line))
  const shown = (doneAt !== -1 ? lines.slice(0, doneAt) : lines).filter(
    (line) => !line.includes(DONE_MARK)
  )
  const match = doneAt !== -1 ? DONE_LINE.exec(lines[doneAt] ?? '') : null
  return { output: shown.join('\n').trimEnd(), exitCode: match ? Number(match[1]) : null }
}

type CreatedTerminal = { terminal: { handle: string } }
type TerminalRead = { terminal: Pick<RuntimeTerminalRead, 'tail' | 'status'> }

export async function runCodeBlockScript(args: {
  call: CodeBlockRunCall
  worktreeId: string
  script: string
  onUpdate: (state: CodeBlockRunState) => void
}): Promise<void> {
  const { call, worktreeId, script, onUpdate } = args
  let output = ''
  let handle: string | null = null
  try {
    onUpdate({ status: 'running', output })
    const created = await call<CreatedTerminal>('terminal.create', {
      worktree: `id:${worktreeId}`,
      command: codeBlockRunCommand(script),
      startupCommandDelivery: 'shell-ready',
      title: 'Code block',
      activate: false,
      focus: false,
      presentation: 'background'
    })
    handle = created.terminal.handle
    const deadline = Date.now() + TIMEOUT_MS
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      const read = await call<TerminalRead>('terminal.read', { terminal: handle, limit: 1000 })
      const result = codeBlockRunOutput(read.terminal.tail)
      output = result.output
      if (result.exitCode !== null) {
        onUpdate({ status: 'done', output, exitCode: result.exitCode })
        return
      }
      if (read.terminal.status === 'exited') {
        onUpdate({ status: 'failed', output, reason: 'closed' })
        return
      }
      onUpdate({ status: 'running', output })
    }
    onUpdate({ status: 'failed', output, reason: 'timeout' })
  } catch (error) {
    onUpdate({
      status: 'failed',
      output,
      reason: 'error',
      message: error instanceof Error ? error.message : String(error)
    })
  } finally {
    if (handle) {
      void call('terminal.close', { terminal: handle }).catch(() => {})
    }
  }
}
