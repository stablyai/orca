import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { getTerminalContent, sendToTerminal, waitForTerminalOutput } from './helpers/terminal'

export type TerminalImeByteReader = {
  expectedLineCount: number
  readyMarker: string
  resultPrefix: string
  scriptPath: string | null
  source: string
}

function createReader(expectedLineCount: number): TerminalImeByteReader {
  const runId = randomUUID().replaceAll('-', '')
  const readyMarker = `ORCA_IME_READER_READY_${runId}`
  const resultPrefix = `ORCA_IME_BYTES_${runId}`
  const source = `
const expectedLineCount = ${expectedLineCount}
const readyMarker = ${JSON.stringify(readyMarker)}
const resultPrefix = ${JSON.stringify(resultPrefix)}
let pending = Buffer.alloc(0)
let receivedLineCount = 0

process.stdout.write(readyMarker + '\\n')
process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, Buffer.from(chunk)])
  let newlineIndex = pending.indexOf(0x0a)
  while (newlineIndex >= 0) {
    const line = pending.subarray(0, newlineIndex + 1)
    pending = pending.subarray(newlineIndex + 1)
    receivedLineCount += 1
    process.stdout.write(resultPrefix + ':' + receivedLineCount + ':' + line.toString('hex') + '\\n')
    if (receivedLineCount === expectedLineCount) {
      process.exit(0)
    }
    newlineIndex = pending.indexOf(0x0a)
  }
})
`
  return { expectedLineCount, readyMarker, resultPrefix, scriptPath: null, source }
}

export function createTerminalImeByteReader(
  testRepoPath: string,
  expectedLineCount: number
): TerminalImeByteReader {
  const reader = createReader(expectedLineCount)
  const runId = reader.readyMarker.slice('ORCA_IME_READER_READY_'.length)
  const scriptPath = path.join(testRepoPath, `.orca-ime-byte-reader-${runId}.cjs`)
  reader.scriptPath = scriptPath
  writeFileSync(scriptPath, reader.source)
  return reader
}

export function createInlineTerminalImeByteReader(
  expectedLineCount: number
): TerminalImeByteReader {
  return createReader(expectedLineCount)
}

export async function startTerminalImeByteReader(
  page: Page,
  ptyId: string,
  reader: TerminalImeByteReader
): Promise<void> {
  const script = reader.scriptPath
    ? JSON.stringify(reader.scriptPath)
    : `-e ${JSON.stringify(
        `eval(Buffer.from('${Buffer.from(reader.source).toString('base64')}', 'base64').toString())`
      )}`
  await sendToTerminal(page, ptyId, `node ${script}\r`)
  await waitForTerminalOutput(page, reader.readyMarker, 10_000, 20_000)
}

export async function waitForTerminalImeBytes(
  page: Page,
  reader: TerminalImeByteReader,
  timeoutMs = 15_000
): Promise<string[]> {
  let results: string[] = []
  await expect
    .poll(
      async () => {
        const terminal = await getTerminalContent(page, 100_000)
        const resultPattern = new RegExp(`${reader.resultPrefix}:(\\d+):([0-9a-f]+)`, 'g')
        const bySequence = new Map<number, string>()
        for (const match of terminal.matchAll(resultPattern)) {
          bySequence.set(Number(match[1]), match[2])
        }
        results = [...bySequence.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, hex]) => hex)
        return results.length
      },
      { timeout: timeoutMs, message: 'IME byte reader did not receive every expected line' }
    )
    .toBe(reader.expectedLineCount)
  return results
}

export function removeTerminalImeByteReader(reader: TerminalImeByteReader): void {
  if (reader.scriptPath) {
    rmSync(reader.scriptPath, { force: true })
  }
}
