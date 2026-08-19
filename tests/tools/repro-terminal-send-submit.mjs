#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const SCRIPT_PATH = import.meta.filename
const BEGIN = '\x1b[200~'
const END = '\x1b[201~'
const DEFAULT_TIMEOUT_MS = 15_000
const COMPOSER_RENDER_MS = 1_200

function argValue(name, fallback = undefined) {
  const prefix = `--${name}=`
  const inline = process.argv.find((arg) => arg.startsWith(prefix))
  if (inline) {
    return inline.slice(prefix.length)
  }
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`)
}

function parsePositiveInteger(name, fallback) {
  const value = Number(argValue(name, fallback))
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer`)
  }
  return value
}

function shellQuote(value) {
  if (process.platform === 'win32') {
    return `"${String(value).replace(/"/g, '\\"')}"`
  }
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
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
      const detail = stderr.trim() || stdout.trim()
      reject(
        Object.assign(
          new Error(`${command} ${args.join(' ')} exited ${code}${detail ? `: ${detail}` : ''}`),
          { stdout, stderr }
        )
      )
    })
  })
}

async function callOrca(cli, args, cwd) {
  const command = cli.endsWith('.mjs') ? process.execPath : cli
  const prefixArgs = cli.endsWith('.mjs') ? [cli] : []
  let stdout
  try {
    const result = await runCommand(command, [...prefixArgs, ...args, '--json'], { cwd })
    stdout = result.stdout
  } catch (error) {
    const parsed = JSON.parse(error?.stdout?.trim() ?? 'null')
    if (parsed?.ok === false) {
      throw Object.assign(new Error(parsed.error?.message ?? JSON.stringify(parsed.error)), {
        code: parsed.error?.code
      })
    }
    throw error
  }
  const parsed = JSON.parse(stdout.trim())
  if (parsed.ok === false) {
    throw Object.assign(new Error(parsed.error?.message ?? JSON.stringify(parsed.error)), {
      code: parsed.error?.code
    })
  }
  return parsed.result ?? parsed
}

async function readReport(reportPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(reportPath, 'utf8'))
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  return null
}

async function closeTerminal(cli, handle, cwd) {
  try {
    await callOrca(cli, ['terminal', 'close', '--terminal', handle], cwd)
  } catch {
    // Best-effort fixture cleanup.
  }
}

async function waitForWorktreeSelector(cli, repoId, cwd) {
  const deadline = Date.now() + 10_000
  const expectedPath = path.resolve(cwd)
  while (Date.now() < deadline) {
    const listed = await callOrca(cli, ['worktree', 'list', '--repo', `id:${repoId}`], cwd)
    const worktree = listed.worktrees?.find((candidate) => {
      const candidatePath = path.resolve(candidate.path)
      return process.platform === 'win32'
        ? candidatePath.toLowerCase() === expectedPath.toLowerCase()
        : candidatePath === expectedPath
    })
    if (worktree?.id) {
      return `id:${worktree.id}`
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`worktree did not materialize for repo ${repoId}`)
}

async function createFakeCodexCommand(tempDir, args) {
  if (process.platform === 'win32') {
    const launcherPath = path.join(tempDir, 'codex.cmd')
    await writeFile(
      launcherPath,
      `@echo off\r\n"${process.execPath}" "${SCRIPT_PATH}" %*\r\n`,
      'utf8'
    )
    return [shellQuote(launcherPath), ...args].join(' ')
  }
  const launcherPath = path.join(tempDir, 'codex')
  await symlink(process.execPath, launcherPath)
  return [shellQuote(launcherPath), shellQuote(SCRIPT_PATH), ...args].join(' ')
}

async function parentMain() {
  const cli = argValue('cli', process.env.ORCA_REPRO_CLI ?? 'orca')
  const cwd = path.resolve(argValue('worktree', process.cwd()))
  const timeoutMs = parsePositiveInteger('timeout-ms', DEFAULT_TIMEOUT_MS)
  const tempDir = path.join(tmpdir(), `orca-terminal-send-submit-${process.pid}-${Date.now()}`)
  const reportPath = path.resolve(argValue('report', path.join(tempDir, 'report.json')))
  const marker = argValue('marker', `ORCA_TERMINAL_SEND_${process.pid}_${Date.now()}`)
  const prompt = `${marker} ${'slow composer payload '.repeat(24)}`
  const expectStalled = hasFlag('expect-stalled')
  const expectBlocked = hasFlag('expect-blocked')
  await mkdir(tempDir, { recursive: true })
  await rm(reportPath, { force: true })

  const command =
    argValue('agent-command') ??
    (await createFakeCodexCommand(tempDir, [
      '--fake-agent',
      '--report',
      shellQuote(reportPath),
      '--marker',
      shellQuote(marker),
      '--timeout-ms',
      String(timeoutMs),
      ...(expectBlocked ? ['--permission-before-send'] : []),
      ...(process.platform === 'win32' ? ['--allow-unframed-paste'] : [])
    ]))
  const added = await callOrca(cli, ['repo', 'add', '--path', cwd], cwd)
  const repoId = added.repo?.id
  if (!repoId) {
    throw new Error('repo add returned no id')
  }
  const worktreeSelector = await waitForWorktreeSelector(cli, repoId, cwd)
  const created = await callOrca(
    cli,
    [
      'terminal',
      'create',
      '--worktree',
      worktreeSelector,
      '--title',
      'terminal send submit repro',
      '--command',
      command
    ],
    cwd
  )
  const handle = created.terminal?.handle
  if (!handle) {
    throw new Error('terminal create returned no handle')
  }

  try {
    if (expectBlocked) {
      const setupReport = await readReport(reportPath, 10_000)
      if (!setupReport) {
        throw new Error('terminal permission prompt did not materialize')
      }
    } else {
      await callOrca(
        cli,
        ['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', '10000'],
        cwd
      )
    }
    let sendErrorCode = null
    try {
      await callOrca(
        cli,
        ['terminal', 'send', '--terminal', handle, '--text', prompt, '--enter'],
        cwd
      )
    } catch (error) {
      const expectedError =
        (expectStalled && error?.code === 'agent_prompt_stalled') ||
        (expectBlocked && error?.code === 'agent_prompt_blocked')
      if (!expectedError) {
        throw error
      }
      sendErrorCode = error.code
    }
    let report = await readReport(reportPath, 1_000)
    let rescueSent = false
    if (!report && !expectStalled && !expectBlocked) {
      rescueSent = true
      await callOrca(cli, ['terminal', 'send', '--terminal', handle, '--enter'], cwd)
      report = await readReport(reportPath, timeoutMs)
    }
    if (!report) {
      throw new Error('fake agent did not write a report')
    }
    const summary = {
      handle,
      promptBytes: Buffer.byteLength(prompt, 'utf8'),
      rescueSent,
      sendErrorCode,
      ...report
    }
    console.log(JSON.stringify(summary, null, 2))
    const expectedStallObserved =
      sendErrorCode === 'agent_prompt_stalled' &&
      report.submitted === false &&
      report.receivedEnters === 1 &&
      report.swallowedEnters === 1
    const expectedBlockObserved =
      sendErrorCode === 'agent_prompt_blocked' &&
      report.receivedBytes === 0 &&
      report.receivedEnters === 0
    if (
      !report.contractOk ||
      rescueSent ||
      (expectStalled && !expectedStallObserved) ||
      (expectBlocked && !expectedBlockObserved)
    ) {
      process.exitCode = 1
    }
  } finally {
    if (!hasFlag('keep-terminal')) {
      await closeTerminal(cli, handle, cwd)
    }
    if (hasFlag('discard-report')) {
      await rm(tempDir, { recursive: true, force: true })
    }
  }
}

async function fakeAgentMain() {
  const reportPath = argValue('report')
  const marker = argValue('marker')
  const timeoutMs = parsePositiveInteger('timeout-ms', DEFAULT_TIMEOUT_MS)
  const pasteFramingRequired = !hasFlag('allow-unframed-paste')
  const swallowFirstEnter = hasFlag('swallow-first-enter')
  const permissionBeforeSend = hasFlag('permission-before-send')
  if (!reportPath || !marker) {
    throw new Error('--fake-agent requires --report and --marker')
  }
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  }
  process.stdin.resume()
  process.stdout.write('OpenAI Codex\nmodel: fake\ndirectory: fixture\n> ')
  if (permissionBeforeSend) {
    process.stdout.write('\nPermission required\nAllow once\nAllow always\nReject\n')
  }

  let input = ''
  let countedCarriages = 0
  let prematureEnters = 0
  let receivedEnters = 0
  let swallowedEnters = 0
  let composerReady = false
  let renderScheduled = false
  let finished = false

  const writeReport = async (submitted) => {
    const hasBracketedPasteFrame = input.includes(BEGIN) && input.includes(END)
    const report = {
      contractOk:
        prematureEnters === 0 &&
        (permissionBeforeSend || !pasteFramingRequired || hasBracketedPasteFrame),
      submitted,
      prematureEnters,
      receivedEnters,
      swallowedEnters,
      pasteFramingRequired,
      hasBracketedPasteFrame,
      markerReceived: input.includes(marker),
      receivedBytes: Buffer.byteLength(input, 'utf8')
    }
    await writeFile(reportPath, JSON.stringify(report, null, 2))
    return report
  }

  const finish = async () => {
    if (finished) {
      return
    }
    finished = true
    const report = await writeReport(true)
    process.stdout.write(`\nORCA_TERMINAL_SEND_REPORT ${report.contractOk ? 'ok' : 'rescued'}\n`)
    process.exit(report.contractOk ? 0 : 7)
  }

  const timeout = setTimeout(() => process.exit(8), timeoutMs)
  if (permissionBeforeSend) {
    setTimeout(() => void writeReport(false), 250)
  }
  process.stdin.on('data', (chunk) => {
    input += chunk.toString('utf8')
    if (!renderScheduled && input.includes(marker)) {
      renderScheduled = true
      setTimeout(() => {
        composerReady = true
        const pasteStart = input.indexOf(BEGIN)
        const pasteEnd = input.indexOf(END, pasteStart + BEGIN.length)
        const composer =
          pasteStart !== -1 && pasteEnd !== -1
            ? input.slice(pasteStart + BEGIN.length, pasteEnd)
            : input
        process.stdout.write(`\x1b[?25h\x1b[2J\x1b[H› ${composer}`)
      }, COMPOSER_RENDER_MS)
    }
    let nextCarriage = input.indexOf('\r', countedCarriages)
    while (nextCarriage !== -1) {
      countedCarriages = nextCarriage + 1
      if (composerReady) {
        receivedEnters += 1
        if (swallowFirstEnter && swallowedEnters === 0) {
          swallowedEnters += 1
          void writeReport(false)
          nextCarriage = input.indexOf('\r', countedCarriages)
          continue
        }
        clearTimeout(timeout)
        process.stdout.write('\x1b]0;Codex working\x07')
        void finish()
        return
      }
      prematureEnters += 1
      nextCarriage = input.indexOf('\r', countedCarriages)
    }
  })
}

async function main() {
  if (hasFlag('fake-agent')) {
    await fakeAgentMain()
    return
  }
  await parentMain()
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error)
  process.exit(1)
})
