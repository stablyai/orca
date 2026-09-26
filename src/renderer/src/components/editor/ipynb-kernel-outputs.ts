import type { KernelOutputType } from '../../../../shared/notebook-kernel-types'
import { isRecord } from './ipynb-parse'

/** An nbformat v4 output; while live it may also carry the kernel's `transient.display_id`. */
export type NotebookOutput = Record<string, unknown>

export type LiveOutputs = {
  outputs: NotebookOutput[]
  /** `clear_output(wait=True)`: clear when the next output arrives, so updates do not flicker. */
  clearOnNextOutput: boolean
}

/** Applies terminal-style `\r` rewrites (progress bars), keeping a trailing `\r` for the next chunk. */
export function collapseCarriageReturns(text: string): string {
  return text.replace(/\r+\n/g, '\n').replace(/^[^\n]*\r(?=[^\n])/gm, '')
}

function displayId(value: unknown): unknown {
  return isRecord(value) && isRecord(value.transient) ? value.transient.display_id : undefined
}

function toOutput(type: KernelOutputType, content: Record<string, unknown>): NotebookOutput {
  if (type === 'error') {
    return {
      output_type: type,
      ename: content.ename ?? '',
      evalue: content.evalue ?? '',
      traceback: content.traceback ?? []
    }
  }
  const bundle = { data: content.data ?? {}, metadata: content.metadata ?? {} }
  if (type === 'execute_result') {
    return { output_type: type, execution_count: content.execution_count ?? null, ...bundle }
  }
  return displayId(content) === undefined
    ? { output_type: 'display_data', ...bundle }
    : { output_type: 'display_data', ...bundle, transient: content.transient }
}

export function applyKernelOutput<T extends LiveOutputs>(
  live: T,
  type: KernelOutputType,
  content: Record<string, unknown>
): T {
  if (type === 'clear_output') {
    return content.wait
      ? { ...live, clearOnNextOutput: true }
      : { ...live, outputs: [], clearOnNextOutput: false }
  }
  if (type === 'update_display_data') {
    const id = displayId(content)
    return {
      ...live,
      outputs: live.outputs.map((output) =>
        id !== undefined && displayId(output) === id
          ? { ...output, data: content.data ?? {}, metadata: content.metadata ?? {} }
          : output
      )
    }
  }
  const outputs = live.clearOnNextOutput ? [] : live.outputs
  const last = outputs.at(-1)
  if (type === 'stream' && last?.output_type === 'stream' && last.name === content.name) {
    const text = collapseCarriageReturns(`${String(last.text)}${String(content.text ?? '')}`)
    return {
      ...live,
      outputs: [...outputs.slice(0, -1), { ...last, text }],
      clearOnNextOutput: false
    }
  }
  const output =
    type === 'stream'
      ? {
          output_type: type,
          name: content.name ?? 'stdout',
          text: collapseCarriageReturns(String(content.text ?? ''))
        }
      : toOutput(type, content)
  return { ...live, outputs: [...outputs, output], clearOnNextOutput: false }
}

/** Drops live-only fields so the outputs are valid nbformat. */
export function toStoredOutputs(outputs: NotebookOutput[]): NotebookOutput[] {
  return outputs.map(({ transient: _transient, ...output }) => output)
}
