import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { vi } from 'vitest'
import { z } from 'zod'

const execFileAsync = promisify(execFile)
const fixtureScript = join(process.cwd(), 'tests/e2e/helpers/windows-semantic-controls-fixture.ps1')

const WindowsSemanticFixtureStateSchema = z.object({
  ready: z.boolean(),
  activations: z.number(),
  active: z.boolean(),
  listOffset: z.number(),
  listViewport: z.number(),
  branchExpanded: z.boolean(),
  level: z.number(),
  events: z.array(z.string())
})

export type WindowsSemanticFixtureState = z.infer<typeof WindowsSemanticFixtureStateSchema>

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
    return WindowsSemanticFixtureStateSchema.parse(JSON.parse(raw.replace(/^﻿/, '')))
  }
  const waitForState = async (
    predicate: (state: WindowsSemanticFixtureState) => boolean,
    label: string
  ): Promise<WindowsSemanticFixtureState> => {
    // Why: the fixture replaces the file on every change, so a read can land between writes and throw.
    return vi.waitFor(
      async () => {
        const state = await readState()
        if (!predicate(state)) {
          throw new Error(`Fixture state not yet ${label}: ${JSON.stringify(state)}`)
        }
        return state
      },
      { timeout: 15_000, interval: 100 }
    )
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
