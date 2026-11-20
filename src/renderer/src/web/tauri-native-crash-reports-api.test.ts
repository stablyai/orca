import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installBrowserGlobals } from './testing/web-preload-api-test-harness'
import type { CrashReportRecord } from '../../../shared/crash-reporting/crash-reporting'

type InvokeHandler = (command: string, args?: Record<string, unknown>) => Promise<unknown>

function installTauriInvoke(handler: InvokeHandler) {
  const globals = installBrowserGlobals('Windows')
  const invoke = vi.fn(handler)
  Object.assign(globals.window, {
    __TAURI_INTERNALS__: { invoke },
    __TAURI__: { event: { listen: vi.fn() } }
  })
  return { invoke }
}

function capturedReport(): CrashReportRecord {
  return {
    id: 'report-1',
    createdAt: '2026-10-20T00:00:00.000Z',
    status: 'pending',
    source: 'renderer',
    processType: 'shell',
    reason: 'rust-panic',
    exitCode: null,
    appVersion: '1.2.3',
    platform: 'win32',
    osRelease: '10',
    arch: 'x64',
    electronVersion: 'tauri',
    chromeVersion: 'webview',
    details: { panicMessage: 'boom' }
  }
}

async function loadApi() {
  const { createTauriNativeCrashReportsApi } = await import('./tauri-native-crash-reports-api')
  const api = createTauriNativeCrashReportsApi()
  if (!api) {
    throw new Error('Tauri crash reports api is unavailable in tests.')
  }
  return api
}

function writtenText(invoke: ReturnType<typeof vi.fn>): string {
  const call = invoke.mock.calls.find(
    ([command]) => command === 'plugin:clipboard-manager|write_text'
  )
  if (!call) {
    throw new Error('clipboard write was not invoked.')
  }
  const args = call[1] as { text?: unknown } | undefined
  return String(args?.text)
}

describe('tauri native crash reports copy', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('copies the captured report with notes and submission failure context', async () => {
    const host = installTauriInvoke((command) => {
      if (command === 'poc_crash_reports_get_requested') {
        return Promise.resolve(capturedReport())
      }
      if (command === 'plugin:clipboard-manager|write_text') {
        return Promise.resolve(null)
      }
      return Promise.reject(new Error(`unexpected command: ${command}`))
    })
    const api = await loadApi()
    const result = await api.copyLatestDiagnostics({
      reportId: 'report-1',
      notes: 'user note',
      submissionFailure: { error: '403' }
    })
    expect(result).toEqual({ ok: true })
    expect(host.invoke).toHaveBeenCalledWith('poc_crash_reports_get_requested', {
      reportId: 'report-1'
    })
    const text = writtenText(host.invoke)
    expect(text).toContain('Report ID: report-1')
    expect(text).toContain('user note')
    expect(text).toContain('Submission failure:')
    expect(text).toContain('Report error: 403')
  })

  it('falls back to uncaptured text when no report was captured', async () => {
    const host = installTauriInvoke((command) => {
      if (command === 'poc_crash_reports_get_requested') {
        return Promise.resolve(null)
      }
      if (command === 'poc_updater_get_version') {
        return Promise.resolve('9.9.9')
      }
      if (command === 'poc_platform_info') {
        return Promise.resolve({ platform: 'win32', osRelease: '11', arch: 'x64' })
      }
      if (command === 'plugin:clipboard-manager|write_text') {
        return Promise.resolve(null)
      }
      return Promise.reject(new Error(`unexpected command: ${command}`))
    })
    const api = await loadApi()
    const result = await api.copyLatestDiagnostics({ notes: 'help menu note' })
    expect(result).toEqual({ ok: true })
    const text = writtenText(host.invoke)
    expect(text).toContain('Report ID: not captured')
    expect(text).toContain('App version: 9.9.9')
    expect(text).toContain('Platform: win32 11 x64')
    expect(text).toContain('help menu note')
  })

  it('falls back to unknown metadata when version and platform lookups fail', async () => {
    const host = installTauriInvoke((command) => {
      if (command === 'poc_crash_reports_get_requested') {
        return Promise.resolve(null)
      }
      if (command === 'plugin:clipboard-manager|write_text') {
        return Promise.resolve(null)
      }
      return Promise.reject(new Error('lookup unavailable'))
    })
    const api = await loadApi()
    const result = await api.copyLatestDiagnostics()
    expect(result).toEqual({ ok: true })
    const text = writtenText(host.invoke)
    expect(text).toContain('Report ID: not captured')
    expect(text).toContain('App version: unknown')
    expect(text).toContain('Platform: win32')
  })

  it('maps oversized clipboard failures to the crash copy error', async () => {
    installTauriInvoke((command) => {
      if (command === 'poc_crash_reports_get_requested') {
        return Promise.resolve(capturedReport())
      }
      if (command === 'plugin:clipboard-manager|write_text') {
        return Promise.reject(new Error('Clipboard text is too large to copy safely.'))
      }
      return Promise.reject(new Error(`unexpected command: ${command}`))
    })
    const api = await loadApi()
    const result = await api.copyLatestDiagnostics({ reportId: 'report-1' })
    expect(result).toEqual({
      ok: false,
      error: 'Crash diagnostics are too large to copy safely.'
    })
  })

  it('surfaces other clipboard failures unchanged', async () => {
    installTauriInvoke((command) => {
      if (command === 'poc_crash_reports_get_requested') {
        return Promise.resolve(capturedReport())
      }
      if (command === 'plugin:clipboard-manager|write_text') {
        return Promise.reject(new Error('denied'))
      }
      return Promise.reject(new Error(`unexpected command: ${command}`))
    })
    const api = await loadApi()
    const result = await api.copyLatestDiagnostics({ reportId: 'report-1' })
    expect(result).toEqual({ ok: false, error: 'denied' })
  })
})
