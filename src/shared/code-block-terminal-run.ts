/** Runs a chat code block in a background terminal and reads its output back for the chat to show under it. */
import type { RuntimeTerminalRead } from './terminal/runtime/runtime-terminal-contracts'
import type { CodeBlockScript } from './code-block-terminal-script'
import { createNonSecureContextUuid } from './identifiers/non-secure-context-uuid'

export type CodeBlockRunCall = <T>(method: string, params: unknown) => Promise<T>

export type CodeBlockRunState =
  | { status: 'running'; output: string; input?: CodeBlockRunInput }
  | { status: 'done'; output: string; exitCode: number }
  | { status: 'failed'; output: string; reason: 'closed' | 'timeout' | 'error'; message?: string }

/** Answers a running block's prompts: a line typed back to it, or Ctrl+C. */
export type CodeBlockRunInput = {
  send: (line: string) => Promise<void>
  interrupt: () => Promise<void>
}

/** What a chat hands its code blocks: run `block`, reporting each new read of its output. */
export type CodeBlockScriptRunner = (
  block: CodeBlockScript,
  onUpdate: (state: CodeBlockRunState) => void
) => Promise<void>

const POLL_MS = 500
const TIMEOUT_MS = 5 * 60_000

// Runs the block in its own shell, so an `exit` in it still lets the wrapper print the status.
const WRAPPER =
  'printf "\\n%s_start\\n" "$2"; s=$(printf "%b" "$1"); "$3" -c "$s"; printf "\\n%s_done_%s\\n" "$2" "$?"'

// Quoted alike by sh, bash, zsh and fish: nothing but plain text sits inside the single quotes.
function quoteForAnyShell(text: string): string {
  return `'${text.replace(/[\\']/g, (c) => (c === '\\' ? "'\\\\'" : "'\\''"))}'`
}

/** One typed line in any of those shells: no tab to complete and no newline to submit early. */
export function codeBlockRunCommand(block: CodeBlockScript, mark: string): string {
  const encoded = block.script
    .replaceAll('\\', '\\\\')
    .replaceAll('\t', '\\t')
    .replaceAll('\n', '\\n')
  return ['sh', '-c', WRAPPER, 'sh', encoded, mark, block.shell].map(quoteForAnyShell).join(' ')
}

/** The lines between this run's start and done marks; exitCode once the done mark printed. */
export function codeBlockRunOutput(
  lines: readonly string[],
  mark: string
): { output: string; exitCode: number | null } {
  const trimmed = lines.map((line) => line.trimEnd())
  const startAt = trimmed.lastIndexOf(`${mark}_start`)
  if (startAt === -1) {
    return { output: '', exitCode: null }
  }
  const donePattern = new RegExp(`^${mark}_done_(\\d+)$`)
  const doneAt = trimmed.findIndex((line, index) => index > startAt && donePattern.test(line))
  const shown = trimmed.slice(startAt + 1, doneAt === -1 ? undefined : doneAt)
  const match = doneAt === -1 ? null : donePattern.exec(trimmed[doneAt] ?? '')
  return { output: shown.join('\n').trim(), exitCode: match ? Number(match[1]) : null }
}

type CreatedTerminal = { terminal: { handle: string } }
type TerminalRead = { terminal: Pick<RuntimeTerminalRead, 'tail' | 'status'> }

export async function runCodeBlockScript(args: {
  call: CodeBlockRunCall
  worktreeId: string
  block: CodeBlockScript
  onUpdate: (state: CodeBlockRunState) => void
}): Promise<void> {
  const { call, worktreeId, block, onUpdate } = args
  // Per run, so a block that prints a mark can't end its own read early.
  const mark = `__orca_run_${createNonSecureContextUuid().replaceAll('-', '')}`
  let output = ''
  let handle: string | null = null
  try {
    onUpdate({ status: 'running', output })
    const created = await call<CreatedTerminal>('terminal.create', {
      worktree: `id:${worktreeId}`,
      command: codeBlockRunCommand(block, mark),
      startupCommandDelivery: 'shell-ready',
      title: 'Code block',
      activate: false,
      focus: false,
      presentation: 'background'
    })
    const terminal = created.terminal.handle
    handle = terminal
    const input: CodeBlockRunInput = {
      send: (line) => call('terminal.send', { terminal, text: line, enter: true }).then(() => {}),
      interrupt: () => call('terminal.send', { terminal, interrupt: true }).then(() => {})
    }
    const deadline = Date.now() + TIMEOUT_MS
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      const read = await call<TerminalRead>('terminal.read', { terminal: handle, limit: 1000 })
      const result = codeBlockRunOutput(read.terminal.tail, mark)
      output = result.output
      if (result.exitCode !== null) {
        onUpdate({ status: 'done', output, exitCode: result.exitCode })
        return
      }
      if (read.terminal.status === 'exited') {
        onUpdate({ status: 'failed', output, reason: 'closed' })
        return
      }
      onUpdate({ status: 'running', output, input })
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
