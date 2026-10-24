import { translate } from '@/i18n/i18n'
import { ownRetainedString } from '../../../../shared/own-retained-string'
import { sliceAtCodeUnitLimit } from '../../../../shared/surrogate-safe-text-slice'
import type { NotebookOutput } from './ipynb-kernel-outputs'
import { noticeOutput } from './ipynb-kernel-runs'
import { isRecord } from './ipynb-parse'

// Why: a larger text block stalls the cell's rendering; rich outputs need more room for images.
const MAX_STREAM_CHARS = 2 * 1024 * 1024
const MAX_OUTPUT_CHARS = 16 * 1024 * 1024
const MAX_OUTPUTS = 2000
const truncationNotices = new WeakSet<NotebookOutput>()
const outputSizes = new WeakMap<NotebookOutput, number>()

function outputSize(output: NotebookOutput): number {
  let size = outputSizes.get(output)
  if (size === undefined) {
    if (output.output_type === 'stream') {
      const { text, ...fields } = output
      size = String(text).length + JSON.stringify(fields).length
    } else {
      size = JSON.stringify(output).length
    }
    outputSizes.set(output, size)
  }
  return size
}

function outputBudget(outputs: NotebookOutput[]) {
  let count = 0
  let streamChars = 0
  let totalChars = 0
  const diagnostics = new Set<unknown>()
  for (const output of outputs) {
    if (truncationNotices.has(output)) {
      continue
    }
    const type = output.output_type
    // Why: the first error and result have separate finite allowances, even after ordinary output fills.
    if ((type === 'error' || type === 'execute_result') && !diagnostics.has(type)) {
      diagnostics.add(type)
      continue
    }
    count += 1
    totalChars += outputSize(output)
    streamChars += type === 'stream' ? String(output.text).length : 0
    // Why: replacements can share a display ID; stop sizing as soon as admission is impossible.
    if (totalChars > MAX_OUTPUT_CHARS) {
      break
    }
  }
  return { count, streamChars, totalChars }
}

export function hasTruncationNotice(outputs: NotebookOutput[]): boolean {
  return outputs.some((output) => truncationNotices.has(output))
}

function withTruncationNotice(outputs: NotebookOutput[]): NotebookOutput[] {
  if (hasTruncationNotice(outputs)) {
    return outputs
  }
  const notice = noticeOutput(
    translate(
      'auto.components.editor.IpynbViewer.outputTruncated',
      'Output truncated: this cell produced more output than Orca keeps. To keep all of it, write it to a file instead.'
    )
  )
  truncationNotices.add(notice)
  return [...outputs, notice]
}

function ownedHead(text: string, limit: number): string {
  return text.length <= limit ? text : ownRetainedString(sliceAtCodeUnitLimit(text, limit))
}

/** Cuts only the new stream text; overflowing rich outputs are omitted whole. */
export function fitOutputBudget(
  previous: NotebookOutput[],
  outputs: NotebookOutput[]
): NotebookOutput[] {
  const { count, streamChars, totalChars } = outputBudget(outputs)
  if (count <= MAX_OUTPUTS && streamChars <= MAX_STREAM_CHARS && totalChars <= MAX_OUTPUT_CHARS) {
    return outputs
  }
  const last = outputs.at(-1)
  let keep = 0
  if (last?.output_type === 'stream' && count <= MAX_OUTPUTS) {
    const text = String(last.text)
    keep = text.length - Math.max(streamChars - MAX_STREAM_CHARS, totalChars - MAX_OUTPUT_CHARS)
    const shown = outputs.length === previous.length ? String(previous.at(-1)?.text).length : 0
    keep = Math.max(keep, Math.min(shown, text.length))
  }
  return withTruncationNotice([
    ...outputs.slice(0, -1),
    ...(last && keep > 0 ? [{ ...last, text: ownedHead(String(last.text), keep) }] : [])
  ])
}

/** Reject an oversized replacement atomically, preserving every display with the matching ID. */
export function fitDisplayUpdateBudget(
  previous: NotebookOutput[],
  outputs: NotebookOutput[]
): NotebookOutput[] {
  return outputBudget(outputs).totalChars <= MAX_OUTPUT_CHARS
    ? outputs
    : withTruncationNotice(previous)
}

function diagnosticText(value: unknown, limit: number): string {
  if (typeof value === 'string') {
    return ownedHead(value, limit)
  }
  if (!Array.isArray(value)) {
    return ''
  }
  let text = ''
  for (const line of value) {
    if (typeof line === 'string') {
      text += ownedHead((text ? '\n' : '') + line, limit - text.length)
    }
    if (text.length >= limit - 1) {
      break
    }
  }
  return text
}

function diagnosticFallback(output: NotebookOutput): NotebookOutput {
  if (output.output_type === 'error') {
    const ename = diagnosticText(output.ename, 1024)
    const evalue = diagnosticText(output.evalue, 64 * 1024)
    const summary = `${ename}: ${evalue}`
    // Why: the renderer displays traceback alone, so its final error summary must survive the cut.
    const traceback = diagnosticText(
      output.traceback,
      MAX_STREAM_CHARS - ename.length - evalue.length - summary.length - 1
    )
    return {
      output_type: 'error',
      ename,
      evalue,
      traceback: traceback ? [traceback, summary] : [summary]
    }
  }
  const data = isRecord(output.data) ? output.data : {}
  const value =
    data['text/plain'] ?? Object.entries(data).find(([mime]) => mime.startsWith('text/'))?.[1]
  return {
    output_type: 'execute_result',
    execution_count: output.execution_count,
    data: { 'text/plain': diagnosticText(value, MAX_STREAM_CHARS) },
    metadata: {}
  }
}

/** Keep a first error/result after the ordinary budget, with its own 16 MiB ceiling. */
export function appendDiagnostic(
  outputs: NotebookOutput[],
  diagnostic: NotebookOutput
): NotebookOutput[] {
  return outputSize(diagnostic) <= MAX_OUTPUT_CHARS
    ? [...outputs, diagnostic]
    : withTruncationNotice([...outputs, diagnosticFallback(diagnostic)])
}
