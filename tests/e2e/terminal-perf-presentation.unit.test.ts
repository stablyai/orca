import type { ElectronApplication, TestInfo } from '@stablyai/playwright-test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  presentTerminalPerfWindow,
  shouldPresentTerminalPerfWindow
} from './terminal-perf-presentation'

describe('terminal perf window presentation', () => {
  afterEach(() => vi.unstubAllGlobals())
  const isolatedDisplay = {
    ORCA_E2E_TERMINAL_PERF_XVFB: '1',
    ORCA_BACKGROUND_LAUNCH: '1',
    GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
    DISPLAY: ':99'
  }

  it.each(['darwin', 'linux', 'win32'])('keeps ordinary %s runs hidden', (platform) => {
    expect(shouldPresentTerminalPerfWindow({}, platform)).toBe(false)
    expect(
      shouldPresentTerminalPerfWindow(
        { ...isolatedDisplay, ORCA_E2E_TERMINAL_PERF_XVFB: '0' },
        platform
      )
    ).toBe(false)
  })

  it('permits the explicit hosted Linux CI display', () => {
    expect(shouldPresentTerminalPerfWindow(isolatedDisplay, 'linux')).toBe(true)
  })

  it.each(['darwin', 'win32'])('rejects visible diagnostics on %s', (platform) => {
    expect(() => shouldPresentTerminalPerfWindow(isolatedDisplay, platform)).toThrow('isolated')
  })

  it.each([
    { ...isolatedDisplay, GITHUB_ACTIONS: undefined },
    { ...isolatedDisplay, GITHUB_ACTIONS: 'false' },
    { ...isolatedDisplay, RUNNER_ENVIRONMENT: 'self-hosted' },
    { ...isolatedDisplay, RUNNER_ENVIRONMENT: undefined },
    { ...isolatedDisplay, DISPLAY: undefined },
    { ...isolatedDisplay, DISPLAY: '' }
  ])('rejects a missing isolated display: %j', (env) => {
    expect(() => shouldPresentTerminalPerfWindow(env, 'linux')).toThrow('isolated')
  })

  function presentationFixture(env: Record<string, string | undefined>, platform = 'linux') {
    vi.stubGlobal('process', { ...process, platform, env })
    const app = { evaluate: vi.fn<ElectronApplication['evaluate']>() }
    const info: Pick<TestInfo, 'annotations'> = { annotations: [] }
    return { app, info }
  }

  it('does not contact Electron during an ordinary local run', async () => {
    const { app, info } = presentationFixture({ ORCA_BACKGROUND_LAUNCH: '1' })
    await presentTerminalPerfWindow(app, info)
    expect(app.evaluate).not.toHaveBeenCalled()
    expect(info.annotations).toEqual([])
  })

  it('rejects a local opt-in before contacting Electron', async () => {
    const { app, info } = presentationFixture({ ...isolatedDisplay, GITHUB_ACTIONS: undefined })
    await expect(presentTerminalPerfWindow(app, info)).rejects.toThrow('isolated')
    expect(app.evaluate).not.toHaveBeenCalled()
    expect(info.annotations).toEqual([])
  })

  it('records presentation only after Electron confirms visibility', async () => {
    const { app, info } = presentationFixture(isolatedDisplay)
    app.evaluate.mockResolvedValue(true)
    await presentTerminalPerfWindow(app, info)
    expect(app.evaluate).toHaveBeenCalledOnce()
    expect(info.annotations).toEqual([
      { type: 'terminal-perf-presentation', description: 'isolated-xvfb' }
    ])
  })

  it('fails instead of measuring an absent or still-hidden window', async () => {
    const { app, info } = presentationFixture(isolatedDisplay)
    app.evaluate.mockResolvedValue(false)
    await expect(presentTerminalPerfWindow(app, info)).rejects.toThrow('not presented')
    expect(info.annotations).toEqual([])
  })
})
