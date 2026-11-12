import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const fixtureScript = join(process.cwd(), 'tests/e2e/helpers/windows-semantic-controls-fixture.ps1')

export type WindowsSemanticFixtureState = {
  ready: boolean
  activations: number
  listOffset: number
  listViewport: number
  branchExpanded: boolean
  level: number
}

export type WindowsSemanticFixture = {
  app: string
  title: string
  readState: () => Promise<WindowsSemanticFixtureState>
  waitForState: (
    predicate: (state: WindowsSemanticFixtureState) => boolean,
    label: string
  ) => Promise<WindowsSemanticFixtureState>
  close: () => Promise<void>
}

export async function launchWindowsSemanticFixture(): Promise<WindowsSemanticFixture> {
  const tempDir = await mkdtemp(join(tmpdir(), 'orca-computer-windows-semantic-'))
  const statePath = join(tempDir, 'state.json')
  const title = `Orca Semantic Controls ${Date.now()}`
  // Why: no windowsHide; Node's hidden startup flag would also hide the fixture's first WPF window.
  const child: ChildProcess = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      fixtureScript,
      '-StatePath',
      statePath,
      '-Title',
      title
    ],
    { stdio: 'ignore' }
  )
  if (child.pid === undefined) {
    throw new Error('failed to start the Windows semantic controls fixture')
  }
  const pid = child.pid

  const readState = async (): Promise<WindowsSemanticFixtureState> => {
    const raw = await readFile(statePath, 'utf8')
    return JSON.parse(raw.replace(/^﻿/, '')) as WindowsSemanticFixtureState
  }
  const waitForState = async (
    predicate: (state: WindowsSemanticFixtureState) => boolean,
    label: string
  ): Promise<WindowsSemanticFixtureState> => {
    const deadline = Date.now() + 15_000
    let last: WindowsSemanticFixtureState | null = null
    while (Date.now() < deadline) {
      try {
        last = await readState()
        if (predicate(last)) {
          return last
        }
      } catch {
        // The fixture replaces the file on every change; a read can land between writes.
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`Timed out waiting for fixture state: ${label}. Last: ${JSON.stringify(last)}`)
  }
  const close = async (): Promise<void> => {
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'])
    } catch {
      // The fixture may already have exited.
    }
    await rm(tempDir, { force: true, recursive: true })
  }

  try {
    await waitForState((state) => state.ready, 'window rendered')
  } catch (error) {
    await close()
    throw error
  }
  return { app: `pid:${pid}`, title, readState, waitForState, close }
}
