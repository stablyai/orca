#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const SCRIPT_PATH = import.meta.filename
const BEGIN = '\x1b[200~'
const END = '\x1b[201~'

const DEFAULT_SIZE_KB = 80
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_MODE = 'codex-like'

function argValue(name, fallback = undefined) {
  const prefix = `--${name}=`
  const inline = process.argv.find((arg) => arg.startsWith(prefix))
  if (inline) {
    return inline.slice(prefix.length)
  }
  const index = process.argv.indexOf(`--${name}`)
  if (index !== -1) {
    return process.argv[index + 1] ?? fallback
  }
  return fallback
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`)
}

function parsePositiveInteger(name, fallback) {
  const raw = argValue(name)
  if (raw === undefined) {
    return fallback
  }
  const value = Number(raw)
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer`)
  }
  return value
}

function shellQuote(value) {
  if (process.platform === 'win32') {
    return `"${String(value).replace(/"/g, '\\"')}"`
  }
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      const error = new Error(`${command} ${args.join(' ')} exited ${code}`)
      error.stdout = stdout
      error.stderr = stderr
      error.code = code
      reject(error)
    })
  })
}

function parseCliJson(output) {
  const text = output.trim()
  if (!text) {
    throw new Error('CLI returned empty JSON output')
  }
  return JSON.parse(text)
}

async function callOrca(cli, args, options = {}) {
  const result = await runCommand(cli, [...args, '--json'], options)
  const parsed = parseCliJson(result.stdout)
  if (parsed.ok === false) {
    throw new Error(parsed.error?.message ?? JSON.stringify(parsed.error))
  }
  return parsed.result ?? parsed
}

function buildLongSpec(sizeKb, marker) {
  const targetBytes = sizeKb * 1024
  const header = [
    `ORCA_LONG_PROMPT_REPRO_START ${marker}`,
    'This task is intentionally long so orchestration dispatch crosses terminal input chunks.',
    'The receiver expects the end marker to arrive before the submit byte.'
  ].join('\n')
  const lines = [header]
  let index = 0
  while (
    Buffer.byteLength(`${lines.join('\n')}\nORCA_LONG_PROMPT_REPRO_END ${marker}`, 'utf8') <
    targetBytes
  ) {
    lines.push(
      `line ${String(index).padStart(5, '0')} ${marker} ${'abcdefghijklmnopqrstuvwxyz 0123456789 '.repeat(3)}`
    )
    index += 1
  }
  lines.push(`ORCA_LONG_PROMPT_REPRO_END ${marker}`)
  return lines.join('\n')
}

function readNested(result, pathParts) {
  let current = result
  for (const part of pathParts) {
    current = current?.[part]
  }
  return current
}

async function waitForReport(reportPath, timeoutMs) {
  const startedAt = Date.now()
  let lastError = null
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return JSON.parse(await readFile(reportPath, 'utf8'))
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  const error = new Error(`Timed out waiting for report: ${reportPath}`)
  error.cause = lastError
  throw error
}

async function tryCloseTerminal(cli, handle, cwd) {
  if (!handle) {
    return
  }
  try {
    await callOrca(cli, ['terminal', 'close', '--terminal', handle], { cwd })
  } catch {
    // Best-effort cleanup; the report is more useful than a close failure.
  }
}

async function parentMain() {
  const cli = argValue('cli', process.env.ORCA_REPRO_CLI ?? 'orca')
  const mode = argValue('mode', DEFAULT_MODE)
  if (!new Set(['wire', 'codex-like']).has(mode)) {
    throw new Error('--mode must be wire or codex-like')
  }
  const sizeKb = parsePositiveInteger('size-kb', DEFAULT_SIZE_KB)
  const timeoutMs = parsePositiveInteger('timeout-ms', DEFAULT_TIMEOUT_MS)
  const cwd = path.resolve(argValue('worktree', process.cwd()))
  const keepTerminals = hasFlag('keep-terminals')
  const discardReport = hasFlag('discard-report')
  const marker = `marker_${randomUUID().replace(/-/g, '')}`
  const spec = buildLongSpec(sizeKb, marker)
  const tempDir = path.join(tmpdir(), `orca-orchestration-long-prompt-${process.pid}-${Date.now()}`)
  await mkdir(tempDir, { recursive: true })
  const workerReportPath = path.join(tempDir, 'worker-report.json')

  console.log(`runtime: ${cli} status`)
  await callOrca(cli, ['status'], { cwd })

  const coordinator = await callOrca(
    cli,
    [
      'terminal',
      'create',
      '--worktree',
      `path:${cwd}`,
      '--title',
      'orchestration repro coordinator',
      '--command',
      `${shellQuote(process.execPath)} ${shellQuote(SCRIPT_PATH)} --fake-coordinator`
    ],
    { cwd }
  )
  const coordinatorHandle = readNested(coordinator, ['terminal', 'handle'])
  if (!coordinatorHandle) {
    throw new Error('Could not create coordinator terminal')
  }

  const workerCommand = [
    shellQuote(process.execPath),
    shellQuote(SCRIPT_PATH),
    '--fake-worker',
    '--cli',
    shellQuote(cli),
    '--mode',
    shellQuote(mode),
    '--report',
    shellQuote(workerReportPath),
    '--marker',
    shellQuote(marker),
    '--timeout-ms',
    String(timeoutMs)
  ].join(' ')
  const worker = await callOrca(
    cli,
    [
      'terminal',
      'create',
      '--worktree',
      `path:${cwd}`,
      '--title',
      'orchestration repro fake codex',
      '--command',
      workerCommand
    ],
    { cwd }
  )
  const workerHandle = readNested(worker, ['terminal', 'handle'])
  if (!workerHandle) {
    throw new Error('Could not create worker terminal')
  }

  let taskId = null
  try {
    await callOrca(
      cli,
      [
        'terminal',
        'wait',
        '--terminal',
        workerHandle,
        '--for',
        'tui-idle',
        '--timeout-ms',
        '10000'
      ],
      { cwd }
    )
    const task = await callOrca(
      cli,
      [
        'orchestration',
        'task-create',
        '--spec',
        spec,
        '--task-title',
        'Long prompt repro',
        '--display-name',
        'Long prompt repro'
      ],
      { cwd }
    )
    taskId = readNested(task, ['task', 'id'])
    if (!taskId) {
      throw new Error('Could not create orchestration task')
    }

    const dispatch = await callOrca(
      cli,
      [
        'orchestration',
        'dispatch',
        '--task',
        taskId,
        '--to',
        workerHandle,
        '--from',
        coordinatorHandle,
        '--inject'
      ],
      { cwd }
    )
    const dispatchId = readNested(dispatch, ['dispatch', 'id'])
    const report = await waitForReport(workerReportPath, timeoutMs)
    const summary = {
      mode,
      sizeKb,
      taskId,
      dispatchId,
      coordinatorHandle,
      workerHandle,
      reportPath: workerReportPath,
      expectedMarker: marker,
      expectedSpecBytes: Buffer.byteLength(spec, 'utf8'),
      ...report
    }
    console.log(JSON.stringify(summary, null, 2))
    if (report.contractOk !== true) {
      process.exitCode = 1
    }
  } finally {
    if (!keepTerminals) {
      await tryCloseTerminal(cli, workerHandle, cwd)
      await tryCloseTerminal(cli, coordinatorHandle, cwd)
    }
    if (discardReport) {
      await rm(tempDir, { recursive: true, force: true })
    }
  }
}

function countUnframedLineBreaks(text) {
  let inPaste = false
  let count = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.startsWith(BEGIN, index)) {
      inPaste = true
      index += BEGIN.length - 1
      continue
    }
    if (text.startsWith(END, index)) {
      inPaste = false
      index += END.length - 1
      continue
    }
    const char = text[index]
    if (!inPaste && (char === '\n' || char === '\r')) {
      count += 1
    }
  }
  return count
}

function buildReport(payload, mode, marker) {
  const firstSubmit = payload.indexOf(0x0d)
  const body = firstSubmit === -1 ? payload : payload.subarray(0, firstSubmit)
  const text = body.toString('utf8')
  const hasBracketedPasteFrame = text.includes(BEGIN) && text.includes(END)
  const hasSubmit = firstSubmit !== -1
  const rawContainsMarker = text.includes(marker)
  const unframedLineBreaks = countUnframedLineBreaks(text)
  const base = {
    mode,
    receivedBytesBeforeSubmit: body.length,
    receivedSha256BeforeSubmit: createHash('sha256').update(body).digest('hex'),
    hasSubmit,
    rawContainsMarker,
    hasBracketedPasteFrame,
    unframedLineBreaks,
    previewStart: text.slice(0, 120),
    previewEnd: text.slice(-120)
  }
  if (mode === 'wire') {
    return {
      ...base,
      contractOk: hasSubmit && rawContainsMarker
    }
  }
  return {
    ...base,
    // Codex/Claude-like TUIs need generated multi-line prompts to arrive as
    // one paste frame; unframed newlines are treated as live editor keys.
    contractOk: hasSubmit && rawContainsMarker && hasBracketedPasteFrame && unframedLineBreaks === 0
  }
}

function parseInjectedIds(text) {
  return {
    taskId: /Your task ID is:\s*(task_[A-Za-z0-9_]+)/.exec(text)?.[1] ?? null,
    dispatchId: /--dispatch-id\s+(ctx_[A-Za-z0-9_]+)/.exec(text)?.[1] ?? null,
    coordinatorHandle: /Your coordinator's terminal handle is:\s*([^\s]+)/.exec(text)?.[1] ?? null
  }
}

async function fakeWorkerMain() {
  const cli = argValue('cli', process.env.ORCA_REPRO_CLI ?? 'orca')
  const mode = argValue('mode', DEFAULT_MODE)
  const reportPath = argValue('report')
  const marker = argValue('marker')
  const timeoutMs = parsePositiveInteger('timeout-ms', DEFAULT_TIMEOUT_MS)
  if (!reportPath || !marker) {
    throw new Error('--fake-worker requires --report and --marker')
  }

  process.stdout.write('\x1b]0;codex ready\x07')
  process.stdout.write('fake codex ready\n> ')
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  }
  process.stdin.resume()

  const chunks = []
  let finished = false
  async function sendWorkerDone(ids, report) {
    if (!ids.taskId || !ids.dispatchId || !ids.coordinatorHandle) {
      return { attempted: false, reason: 'missing-dispatch-identifiers' }
    }
    try {
      await callOrca(cli, [
        'orchestration',
        'send',
        '--to',
        ids.coordinatorHandle,
        '--type',
        'worker_done',
        '--subject',
        report.contractOk
          ? 'Harness observed safe prompt delivery'
          : 'Harness reproduced unsafe prompt delivery',
        '--body',
        [
          `The fake worker received ${report.receivedBytesBeforeSubmit} bytes before submit.`,
          `Bracketed paste frame present: ${String(report.hasBracketedPasteFrame)}.`,
          `Unframed line breaks: ${String(report.unframedLineBreaks)}.`
        ].join(' '),
        '--task-id',
        ids.taskId,
        '--dispatch-id',
        ids.dispatchId,
        '--report-path',
        reportPath
      ])
      return { attempted: true, ok: true }
    } catch (error) {
      return {
        attempted: true,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  const finish = async (reason) => {
    if (finished) {
      return
    }
    finished = true
    const payload = Buffer.concat(chunks)
    const report = {
      reason,
      ...buildReport(payload, mode, marker)
    }
    const ids = parseInjectedIds(payload.toString('utf8'))
    report.parsedTaskId = ids.taskId
    report.parsedDispatchId = ids.dispatchId
    report.parsedCoordinatorHandle = ids.coordinatorHandle
    report.workerDone = await sendWorkerDone(ids, report)
    await writeFile(reportPath, JSON.stringify(report, null, 2))
    process.stdout.write(
      `\nORCA_REPRO_REPORT ${report.contractOk ? 'ok' : 'failed'} ${reportPath}\n`
    )
    process.exit(report.contractOk ? 0 : 7)
  }

  const timer = setTimeout(() => {
    finish('timeout').catch(() => process.exit(8))
  }, timeoutMs)
  process.stdin.on('data', (chunk) => {
    chunks.push(Buffer.from(chunk))
    if (Buffer.concat(chunks).includes(0x0d)) {
      clearTimeout(timer)
      finish('submit').catch(() => process.exit(8))
    }
  })
}

function fakeCoordinatorMain() {
  process.stdout.write('\x1b]0;orchestration repro coordinator\x07')
  process.stdout.write('orchestration repro coordinator ready\n')
  setInterval(() => {}, 60_000)
}

async function main() {
  if (hasFlag('help')) {
    console.log(`Usage:
  node tools/repro-orchestration-long-prompt.mjs [--mode codex-like|wire] [--size-kb 80]

The parent mode requires a running Orca runtime and creates temporary Orca
terminals. The fake worker records whether orchestration dispatch delivered a
long prompt in a safe agent-input contract.

Options:
  --cli <path>         Orca CLI command (default: ORCA_REPRO_CLI or orca)
  --worktree <path>   Worktree path for temporary terminals (default: cwd)
  --timeout-ms <n>    Wait budget for terminal/report operations
  --keep-terminals    Leave temporary terminals open for inspection
  --discard-report    Delete the temporary JSON report after printing summary
`)
    return
  }
  if (hasFlag('fake-worker')) {
    await fakeWorkerMain()
    return
  }
  if (hasFlag('fake-coordinator')) {
    fakeCoordinatorMain()
    return
  }
  await parentMain()
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error)
  process.exit(1)
})
