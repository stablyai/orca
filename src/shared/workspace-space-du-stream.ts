import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import {
  createWorkspaceSpaceScanBudget,
  retainWorkspaceSpaceScanEntry,
  type WorkspaceSpaceScanBudget
} from './workspace-space-scan-budget'

export const WORKSPACE_SPACE_DU_TIMEOUT_MS = 120_000
const DU_STDERR_MAX_CHARS = 64 * 1024

export class WorkspaceSpaceDuTimeoutError extends Error {
  constructor() {
    super(`du timed out after ${WORKSPACE_SPACE_DU_TIMEOUT_MS}ms`)
    this.name = 'WorkspaceSpaceDuTimeoutError'
  }
}

export type ReadWorkspaceSpaceDuDepthOneOptions = {
  signal?: AbortSignal
  isCancelled?: () => boolean
  normalizePath: (path: string) => string
  createTimeoutError?: () => Error
  createCancelledError: () => Error
}

function parseDuDepthOneLine(
  line: string,
  normalizePath: (path: string) => string
): [string, number] | null {
  const normalizedLine = line.endsWith('\r') ? line.slice(0, -1) : line
  if (!normalizedLine) {
    return null
  }
  const match = /^(\d+)\s+(.+)$/.exec(normalizedLine)
  if (!match) {
    return null
  }
  return [normalizePath(match[2]), Number(match[1]) * 1024]
}

function consumeDuOutputChunk(
  sizes: Map<string, number>,
  budget: WorkspaceSpaceScanBudget,
  bufferedLine: string,
  chunkText: string,
  normalizePath: (path: string) => string
): string {
  const lines = `${bufferedLine}${chunkText}`.split('\n')
  const nextBufferedLine = lines.pop() ?? ''
  for (const line of lines) {
    const parsed = parseDuDepthOneLine(line, normalizePath)
    if (parsed) {
      if (!sizes.has(parsed[0])) {
        retainWorkspaceSpaceScanEntry(budget, parsed[0], sizes.size)
      }
      sizes.set(parsed[0], parsed[1])
    }
  }
  return nextBufferedLine
}

function retainParsedDuLine(
  sizes: Map<string, number>,
  budget: WorkspaceSpaceScanBudget,
  parsed: [string, number]
): void {
  if (!sizes.has(parsed[0])) {
    retainWorkspaceSpaceScanEntry(budget, parsed[0], sizes.size)
  }
  sizes.set(parsed[0], parsed[1])
}

export function readWorkspaceSpaceDuDepthOne(
  rootPath: string,
  options: ReadWorkspaceSpaceDuDepthOneOptions
): Promise<Map<string, number>> {
  const { signal, normalizePath } = options
  return new Promise<Map<string, number>>((resolve, reject) => {
    let settled = false
    let child: ChildProcessByStdio<null, Readable, Readable> | undefined
    let onAbort: (() => void) | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let bufferedLine = ''
    let stderr = ''
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    const sizes = new Map<string, number>()
    const budget = createWorkspaceSpaceScanBudget()
    const appendStderr = (chunkText: string): void => {
      if (stderr.length < DU_STDERR_MAX_CHARS) {
        stderr = `${stderr}${chunkText}`.slice(0, DU_STDERR_MAX_CHARS)
      }
    }
    const settle = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearTimeout(timer)
      }
      if (onAbort) {
        signal?.removeEventListener('abort', onAbort)
      }
      callback()
    }
    onAbort = () => {
      settle(() => {
        child?.kill()
        reject(options.createCancelledError())
      })
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted || options.isCancelled?.()) {
      onAbort()
      return
    }

    try {
      // Why: stream beyond execFile's fixed buffer while bounding retained rows.
      child = spawn('du', ['-k', '-d', '1', rootPath], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      settle(() => reject(error))
      return
    }
    timer = setTimeout(() => {
      settle(() => {
        child?.kill()
        reject(options.createTimeoutError?.() ?? new WorkspaceSpaceDuTimeoutError())
      })
    }, WORKSPACE_SPACE_DU_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      if (settled) {
        return
      }
      try {
        if (options.isCancelled?.()) {
          onAbort?.()
          return
        }
        bufferedLine = consumeDuOutputChunk(
          sizes,
          budget,
          bufferedLine,
          stdoutDecoder.write(chunk),
          normalizePath
        )
      } catch (error) {
        settle(() => {
          child?.kill()
          reject(error)
        })
      }
    })
    child.stderr.on('data', (chunk) => {
      appendStderr(stderrDecoder.write(chunk))
    })
    child.once('error', (error) => {
      settle(() => reject(error))
    })
    child.once('close', (code) => {
      if (settled) {
        return
      }
      try {
        const decodedTail = stdoutDecoder.end()
        if (decodedTail) {
          bufferedLine = consumeDuOutputChunk(
            sizes,
            budget,
            bufferedLine,
            decodedTail,
            normalizePath
          )
        }
        appendStderr(stderrDecoder.end())
        const parsed = parseDuDepthOneLine(bufferedLine, normalizePath)
        if (parsed) {
          retainParsedDuLine(sizes, budget, parsed)
        }
      } catch (error) {
        settle(() => reject(error))
        return
      }
      settle(() => {
        if (code === 0) {
          resolve(sizes)
          return
        }
        reject(new Error(stderr.trim() || `du exited with code ${code ?? 'null'}`))
      })
    })
  })
}
