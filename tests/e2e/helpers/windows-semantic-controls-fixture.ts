import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { vi } from 'vitest'
import { z } from 'zod'

const execFileAsync = promisify(execFile)
const helpersDir = join(process.cwd(), 'tests/e2e/helpers')

const FixtureActivationSchema = z.object({
  ready: z.boolean(),
  activations: z.number(),
  active: z.boolean(),
  events: z.array(z.string())
})

const WindowsSemanticFixtureStateSchema = FixtureActivationSchema.extend({
  listOffset: z.number(),
  listViewport: z.number(),
  branchExpanded: z.boolean(),
  level: z.number()
})

const WindowsFormsFixtureStateSchema = FixtureActivationSchema.extend({
  name: z.string(),
  notes: z.string()
})

export type WindowsSemanticFixtureState = z.infer<typeof WindowsSemanticFixtureStateSchema>
export type WindowsFormsFixtureState = z.infer<typeof WindowsFormsFixtureStateSchema>

export type WindowsControlsFixture<State> = {
  app: string
  title: string
  readState: () => Promise<State>
  waitForState: (predicate: (state: State) => boolean, label: string) => Promise<State>
  close: () => Promise<void>
}

export type WindowsSemanticFixture = WindowsControlsFixture<WindowsSemanticFixtureState>
export type WindowsFormsFixture = WindowsControlsFixture<WindowsFormsFixtureState>

// WPF window behind another app's window, recording each activation.
export function launchWindowsSemanticFixture(): Promise<WindowsSemanticFixture> {
  return launchWindowsControlsFixture(
    'windows-semantic-controls-fixture.ps1',
    WindowsSemanticFixtureStateSchema
  )
}

// The same for a WinForms window, whose text boxes are native user32 edits.
export function launchWindowsFormsFixture(): Promise<WindowsFormsFixture> {
  return launchWindowsControlsFixture(
    'windows-semantic-controls-fixture.winforms.ps1',
    WindowsFormsFixtureStateSchema
  )
}

async function launchWindowsControlsFixture<State extends z.infer<typeof FixtureActivationSchema>>(
  script: string,
  schema: z.ZodType<State>
): Promise<WindowsControlsFixture<State>> {
  const fixtureScript = join(helpersDir, script)
  const tempDir = await mkdtemp(join(tmpdir(), 'orca-computer-windows-semantic-'))
  const statePath = join(tempDir, 'state.json')
  const title = `Orca Semantic Controls ${Date.now()}`
  const holderTitle = `${title} holder`
  // Why: a window in another process takes activation back, as the user's own app would hold it.
  const holder: ChildProcess = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-Command',
      `Add-Type -AssemblyName System.Windows.Forms; $form = New-Object Windows.Forms.Form; $form.Text = '${holderTitle}'; [Windows.Forms.Application]::Run($form)`
    ],
    { stdio: 'ignore' }
  )
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
      title,
      '-HolderTitle',
      holderTitle
    ],
    { stdio: 'ignore' }
  )
  if (child.pid === undefined) {
    throw new Error('failed to start the Windows semantic controls fixture')
  }
  const pid = child.pid

  const readState = async (): Promise<State> => {
    const raw = await readFile(statePath, 'utf8')
    return schema.parse(JSON.parse(raw.replace(/^﻿/, '')))
  }
  const waitForState = async (
    predicate: (state: State) => boolean,
    label: string
  ): Promise<State> => {
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
    for (const owned of [pid, holder.pid].filter((value) => value !== undefined)) {
      try {
        await execFileAsync('taskkill.exe', ['/PID', String(owned), '/T', '/F'])
      } catch {
        // The fixture or holder may already have exited.
      }
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
