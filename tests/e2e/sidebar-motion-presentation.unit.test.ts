import type { ElectronApplication, TestInfo } from '@stablyai/playwright-test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  presentSidebarMotionWindow,
  shouldPresentSidebarMotionWindow
} from './sidebar-motion-presentation'
import { shouldPresentTerminalPerfWindow } from './terminal-perf-presentation'

describe('sidebar motion window presentation', () => {
  afterEach(() => vi.unstubAllGlobals())
  const isolatedDisplay = {
    ORCA_E2E_SIDEBAR_MOTION_XVFB: '1',
    ORCA_BACKGROUND_LAUNCH: '1',
    GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
    DISPLAY: ':99'
  }

  it.each(['darwin', 'linux', 'win32'])('keeps ordinary %s runs hidden', (platform) => {
    expect(shouldPresentSidebarMotionWindow({}, platform)).toBe(false)
    expect(
      shouldPresentSidebarMotionWindow(
        { ...isolatedDisplay, ORCA_E2E_SIDEBAR_MOTION_XVFB: '0' },
        platform
      )
    ).toBe(false)
  })

  it('permits the explicit hosted Linux CI display', () => {
    expect(shouldPresentSidebarMotionWindow(isolatedDisplay, 'linux')).toBe(true)
  })

  it.each(['darwin', 'win32'])('rejects visible diagnostics on %s', (platform) => {
    expect(() => shouldPresentSidebarMotionWindow(isolatedDisplay, platform)).toThrow('isolated')
  })

  it.each([
    { ...isolatedDisplay, GITHUB_ACTIONS: undefined },
    { ...isolatedDisplay, GITHUB_ACTIONS: 'false' },
    { ...isolatedDisplay, RUNNER_ENVIRONMENT: 'self-hosted' },
    { ...isolatedDisplay, RUNNER_ENVIRONMENT: undefined },
    { ...isolatedDisplay, DISPLAY: undefined },
    { ...isolatedDisplay, DISPLAY: '' }
  ])('rejects a missing isolated display: %j', (env) => {
    expect(() => shouldPresentSidebarMotionWindow(env, 'linux')).toThrow('isolated')
  })

  it('keeps the two isolated-display exceptions independent', () => {
    expect(shouldPresentTerminalPerfWindow(isolatedDisplay, 'linux')).toBe(false)
    expect(
      shouldPresentSidebarMotionWindow(
        {
          ORCA_E2E_TERMINAL_PERF_XVFB: '1',
          GITHUB_ACTIONS: 'true',
          RUNNER_ENVIRONMENT: 'github-hosted',
          DISPLAY: ':99'
        },
        'linux'
      )
    ).toBe(false)
  })

  function presentationFixture(env: Record<string, string | undefined>, platform = 'linux') {
    vi.stubGlobal('process', { ...process, platform, env })
    const app = { evaluate: vi.fn<ElectronApplication['evaluate']>() }
    const info: Pick<TestInfo, 'annotations'> = { annotations: [] }
    return { app, info }
  }

  it('does not contact Electron during an ordinary local run', async () => {
    const { app, info } = presentationFixture({ ORCA_BACKGROUND_LAUNCH: '1' })
    expect(await presentSidebarMotionWindow(app, info)).toEqual({
      presented: false,
      windows: 0,
      visible: 0
    })
    expect(app.evaluate).not.toHaveBeenCalled()
    expect(info.annotations).toEqual([])
  })

  it('rejects a local opt-in before contacting Electron', async () => {
    const { app, info } = presentationFixture({ ...isolatedDisplay, GITHUB_ACTIONS: undefined })
    await expect(presentSidebarMotionWindow(app, info)).rejects.toThrow('isolated')
    expect(app.evaluate).not.toHaveBeenCalled()
    expect(info.annotations).toEqual([])
  })

  it('reports counts only after Electron confirms every window is visible', async () => {
    const { app, info } = presentationFixture(isolatedDisplay)
    app.evaluate.mockResolvedValueOnce(true).mockResolvedValueOnce({ windows: 1, visible: 1 })
    expect(await presentSidebarMotionWindow(app, info)).toEqual({
      presented: true,
      windows: 1,
      visible: 1
    })
    expect(app.evaluate).toHaveBeenCalledTimes(2)
    expect(info.annotations).toEqual([
      { type: 'sidebar-motion-presentation', description: 'isolated-xvfb' }
    ])
  })

  it('fails instead of measuring an absent or still-hidden window', async () => {
    const { app, info } = presentationFixture(isolatedDisplay)
    app.evaluate.mockResolvedValue(false)
    await expect(presentSidebarMotionWindow(app, info)).rejects.toThrow('not presented')
    expect(app.evaluate).toHaveBeenCalledOnce()
    expect(info.annotations).toEqual([])
  })
})
