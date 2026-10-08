// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useDialogRegistry } from '@/store/dialog-registry'
import { resetDialogRegistryForTests } from '@/store/dialog-registry-test-state'
import { getDefaultSettings } from '../../../../shared/constants'
import type { CrashReportRecord } from '../../../../shared/crash-reporting'
import { CrashReportDialog } from './CrashReportDialog'
import { SshPassphraseDialog } from '../settings/SshPassphraseDialog'
import { TooltipProvider } from '../ui/tooltip'

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    dismiss: vi.fn()
  })
}))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement

const pendingCrash: CrashReportRecord = {
  id: 'crash-1',
  createdAt: '2026-10-05T00:00:00.000Z',
  status: 'pending',
  source: 'renderer',
  processType: 'renderer',
  reason: 'crashed',
  exitCode: 5,
  appVersion: '1.0.0',
  platform: 'darwin',
  osRelease: 'test',
  arch: 'arm64',
  electronVersion: '1',
  chromeVersion: '1',
  details: {}
}

const newerCrash: CrashReportRecord = {
  ...pendingCrash,
  id: 'crash-2',
  createdAt: '2026-10-05T01:00:00.000Z',
  appVersion: '9.9.9'
}

let openCrashReportFromMenu: () => void = () => {}
let resolveSubmit: (value: unknown) => void = () => {}
const crashReports = {
  getLatestPending: vi.fn(async (): Promise<CrashReportRecord | null> => pendingCrash),
  getLatestReport: vi.fn(async (): Promise<CrashReportRecord | null> => null),
  dismiss: vi.fn(async () => undefined),
  submit: vi.fn(
    () =>
      new Promise((resolve) => {
        resolveSubmit = resolve
      })
  )
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function crashOnScreen(): boolean {
  return document.body.textContent?.includes('Send Report') === true
}

function sshOnScreen(): boolean {
  return document.body.textContent?.includes('SSH Key Passphrase') === true
}

function notes(): string {
  return document.querySelector<HTMLTextAreaElement>('textarea')?.value ?? ''
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) =>
    b.textContent?.trim().endsWith(label)
  )
  if (!found) {
    throw new Error(`Missing button: ${label}`)
  }
  return found
}

function typeNotes(text: string): void {
  const area = document.querySelector('textarea')
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (!area || !setter) {
    throw new Error('Missing notes field')
  }
  act(() => {
    setter.call(area, text)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** The SSH prompt as the app hosts it. */
function SshHost(): React.JSX.Element | null {
  const asked = useAppStore((s) => s.sshCredentialQueue.length > 0)
  return asked ? <SshPassphraseDialog /> : null
}

beforeEach(() => {
  crashReports.submit.mockClear()
  crashReports.dismiss.mockClear()
  crashReports.getLatestPending.mockReset().mockResolvedValue(pendingCrash)
  crashReports.getLatestReport.mockReset().mockResolvedValue(null)
  resetDialogRegistryForTests({ startupSettled: true })
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({ settings: getDefaultSettings('') })
  Object.assign(window, {
    api: {
      crashReports,
      ui: {
        onOpenCrashReport: (cb: () => void) => {
          openCrashReportFromMenu = cb
          return () => {}
        }
      },
      ssh: { submitCredential: vi.fn(async () => undefined) },
      gh: { viewer: vi.fn(async () => null) }
    }
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function mountBoth({ waitForCrash = true } = {}): Promise<void> {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <CrashReportDialog />
        <SshHost />
      </TooltipProvider>
    )
  )
  await flush()
  if (waitForCrash) {
    await vi.waitFor(() => expect(crashOnScreen()).toBe(true), { timeout: 5000 })
  }
}

function raiseSsh(): void {
  act(() => {
    useAppStore.getState().enqueueSshCredentialRequest({
      requestId: 'r1',
      targetId: 't1',
      kind: 'passphrase',
      detail: '~/.ssh/id_ed25519'
    })
  })
}

async function openFromHelp(): Promise<void> {
  await act(async () => openCrashReportFromMenu())
  await flush()
}

it('an SSH prompt stacks over the launch crash report, which keeps its notes throughout', async () => {
  await mountBoth()
  typeNotes('it crashed when I opened the diff')
  const area = document.querySelector('textarea')
  raiseSsh()
  await flush()
  expect(sshOnScreen()).toBe(true)
  expect(document.querySelector('textarea')).toBe(area)
  expect(notes()).toBe('it crashed when I opened the diff')

  await act(async () => useAppStore.getState().removeSshCredentialRequest('r1'))
  await flush()
  expect(document.querySelector('textarea')).toBe(area)
  expect(notes()).toBe('it crashed when I opened the diff')
})

it('a report sent while an SSH prompt interrupts it is sent once and the dialog closes', async () => {
  await mountBoth()
  typeNotes('notes')
  await act(async () => button('Send Report').click())
  expect(crashReports.submit).toHaveBeenCalledTimes(1)
  raiseSsh()
  await flush()
  await act(async () => {
    resolveSubmit({ ok: true, report: { ...pendingCrash, status: 'submitted' } })
  })
  await flush()
  await act(async () => useAppStore.getState().removeSshCredentialRequest('r1'))
  await flush()
  expect(crashOnScreen()).toBe(false)
  expect(crashReports.submit).toHaveBeenCalledTimes(1)
  expect(useDialogRegistry.getState().dialogEntries).toEqual([])
})

it('Help > Report Crash over the report on screen keeps that report, its dialog and its notes', async () => {
  crashReports.getLatestReport.mockResolvedValue(newerCrash)
  await mountBoth()
  typeNotes('it crashed when I opened the diff')
  const area = document.querySelector('textarea')
  await openFromHelp()
  expect(document.querySelector('textarea')).toBe(area)
  expect(notes()).toBe('it crashed when I opened the diff')
  // Never swapped for a different report under the user's notes.
  expect(document.body.textContent).toContain('Orca 1.0.0')
  expect(document.body.textContent).not.toContain('Orca 9.9.9')

  await act(async () => button("Don't Send").click())
  await flush()
  // One report, one dialog: closing it does not bring the same report back.
  expect(crashOnScreen()).toBe(false)
  expect(useDialogRegistry.getState().dialogEntries).toEqual([])
})

it('a send in flight when Help > Report Crash opens is sent once and closes the dialog', async () => {
  await mountBoth()
  await act(async () => button('Send Report').click())
  await openFromHelp()
  await act(async () => {
    resolveSubmit({ ok: true, report: { ...pendingCrash, status: 'submitted' } })
  })
  await flush()
  expect(crashOnScreen()).toBe(false)
  expect(crashReports.submit).toHaveBeenCalledTimes(1)
})

it('Help with nothing on screen opens at once and fills in the latest report', async () => {
  crashReports.getLatestPending.mockResolvedValue(null)
  const latest = Promise.withResolvers<CrashReportRecord | null>()
  crashReports.getLatestReport.mockReturnValue(latest.promise)
  await mountBoth({ waitForCrash: false })
  await openFromHelp()
  expect(crashOnScreen()).toBe(true)
  typeNotes('typed while loading')
  const area = document.querySelector('textarea')
  await act(async () => latest.resolve(newerCrash))
  await flush()
  expect(document.body.textContent).toContain('Orca 9.9.9')
  expect(document.querySelector('textarea')).toBe(area)
  expect(notes()).toBe('typed while loading')
})

it('a latest-report load that lands after Help over a report on screen never swaps it', async () => {
  const pending = Promise.withResolvers<CrashReportRecord | null>()
  crashReports.getLatestPending.mockReturnValue(pending.promise)
  const latest = Promise.withResolvers<CrashReportRecord | null>()
  crashReports.getLatestReport.mockReturnValue(latest.promise)
  await mountBoth({ waitForCrash: false })
  await openFromHelp()
  await act(async () => button("Don't Send").click())
  await flush()
  await act(async () => pending.resolve(pendingCrash))
  await flush()
  expect(document.body.textContent).toContain('Orca 1.0.0')
  await openFromHelp()
  await act(async () => latest.resolve(newerCrash))
  await flush()
  expect(document.body.textContent).toContain('Orca 1.0.0')
  expect(document.body.textContent).not.toContain('Orca 9.9.9')
})

it('Help pressed again while its dialog is open keeps the same dialog and its notes', async () => {
  crashReports.getLatestPending.mockResolvedValue(null)
  crashReports.getLatestReport.mockResolvedValue(newerCrash)
  await mountBoth({ waitForCrash: false })
  await openFromHelp()
  typeNotes('second help press')
  await openFromHelp()
  expect(notes()).toBe('second help press')
  expect(crashReports.getLatestReport).toHaveBeenCalledTimes(1)
})

it('Help opens at once over a queued report, which then waits behind it', async () => {
  crashReports.getLatestPending.mockResolvedValue(null)
  await mountBoth({ waitForCrash: false })
  raiseSsh()
  await flush()
  await openFromHelp()
  expect(crashOnScreen()).toBe(true)
  expect(sshOnScreen()).toBe(true)
})
