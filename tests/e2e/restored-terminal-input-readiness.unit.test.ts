import type { Page } from '@stablyai/playwright-test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitForRestoredTerminalInputReady } from './helpers/restored-terminal-input-readiness'

type TestPane = {
  container: {
    dataset: { ptyId: string }
    __orcaE2eTerminalInputReadinessInstanceId?: string
  }
  serializeAddon: { serialize: () => string }
  terminal: { input: (data: string, wasUserInput: boolean) => void }
}

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')

function installPaneWindow(pane: TestPane): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __paneManagers: new Map([
        [
          'tab-1',
          {
            getActivePane: () => pane,
            getPanes: () => [pane]
          }
        ]
      ])
    }
  })
}

function createPage(): Page {
  return {
    evaluate: async (callback: (arg: unknown) => unknown, arg: unknown) => callback(arg),
    waitForTimeout: async (timeoutMs: number) => {
      await vi.advanceTimersByTimeAsync(timeoutMs)
    }
  } as unknown as Page
}

describe('restored terminal input readiness', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalWindowDescriptor) {
      Object.defineProperty(globalThis, 'window', originalWindowDescriptor)
    } else {
      Reflect.deleteProperty(globalThis, 'window')
    }
  })

  it('retries after replay drops the first full input payload', async () => {
    let content = ''
    let attempts = 0
    const input = vi.fn((data: string) => {
      attempts += 1
      if (attempts >= 2) {
        content = data
      }
    })
    installPaneWindow({
      container: { dataset: { ptyId: 'pty-1' } },
      serializeAddon: { serialize: () => content },
      terminal: { input }
    })

    await expect(waitForRestoredTerminalInputReady(createPage(), 'pty-1', 500)).resolves.toBe(true)
    expect(input).toHaveBeenCalledTimes(2)
    expect(input.mock.calls.every(([, wasUserInput]) => wasUserInput === true)).toBe(true)
  })

  it('accepts a healthy PTY echo that arrives after multiple poll intervals', async () => {
    let content = ''
    const input = vi.fn((data: string) => {
      setTimeout(() => {
        content = data
      }, 250)
    })
    installPaneWindow({
      container: { dataset: { ptyId: 'pty-1' } },
      serializeAddon: { serialize: () => content },
      terminal: { input }
    })

    await expect(waitForRestoredTerminalInputReady(createPage(), 'pty-1', 800)).resolves.toBe(true)
    expect(input.mock.calls.length).toBeGreaterThan(1)
  })

  it('never treats a different pane PTY as ready', async () => {
    const input = vi.fn()
    installPaneWindow({
      container: { dataset: { ptyId: 'pty-other' } },
      serializeAddon: { serialize: () => 'unrelated terminal output' },
      terminal: { input }
    })

    await expect(waitForRestoredTerminalInputReady(createPage(), 'pty-1', 250)).resolves.toBe(false)
    expect(input).not.toHaveBeenCalled()
  })

  it('does not accept a marker replayed into a replacement pane', async () => {
    let activePane: TestPane
    let replacementContent = ''
    const replacementInput = vi.fn((data: string) => {
      replacementContent = data
    })
    const replacementPane: TestPane = {
      container: { dataset: { ptyId: 'pty-1' } },
      serializeAddon: { serialize: () => replacementContent },
      terminal: { input: replacementInput }
    }
    const firstInput = vi.fn((data: string) => {
      replacementContent = data
      activePane = replacementPane
    })
    activePane = {
      container: { dataset: { ptyId: 'pty-1' } },
      serializeAddon: { serialize: () => '' },
      terminal: { input: firstInput }
    }
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __paneManagers: new Map([
          [
            'tab-1',
            {
              getActivePane: () => activePane,
              getPanes: () => [activePane]
            }
          ]
        ])
      }
    })

    await expect(waitForRestoredTerminalInputReady(createPage(), 'pty-1', 500)).resolves.toBe(true)
    expect(firstInput).toHaveBeenCalledTimes(1)
    expect(replacementInput).toHaveBeenCalledTimes(1)
  })

  it('discards stale attempts when document replacement rejects evaluation', async () => {
    let activePane: TestPane
    let replacementContent = ''
    const replacementInput = vi.fn((data: string) => {
      replacementContent = data
    })
    const replacementPane: TestPane = {
      container: { dataset: { ptyId: 'pty-1' } },
      serializeAddon: { serialize: () => replacementContent },
      terminal: { input: replacementInput }
    }
    let originalInputCalls = 0
    const firstInput = vi.fn((data: string) => {
      originalInputCalls += 1
      if (originalInputCalls === 2) {
        replacementContent = data
        activePane = replacementPane
      }
    })
    activePane = {
      container: { dataset: { ptyId: 'pty-1' } },
      serializeAddon: { serialize: () => '' },
      terminal: { input: firstInput }
    }
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __paneManagers: new Map([
          [
            'tab-1',
            {
              getActivePane: () => activePane,
              getPanes: () => [activePane]
            }
          ]
        ])
      }
    })

    const pendingAttemptCounts: number[] = []
    let evaluateCalls = 0
    const page = {
      evaluate: async (callback: (arg: unknown) => unknown, arg: unknown) => {
        evaluateCalls += 1
        pendingAttemptCounts.push(
          (arg as { pendingAttempts: readonly unknown[] }).pendingAttempts.length
        )
        const result = callback(arg)
        if (evaluateCalls === 2) {
          throw new Error('Execution context was destroyed')
        }
        return result
      },
      waitForTimeout: async (timeoutMs: number) => {
        await vi.advanceTimersByTimeAsync(timeoutMs)
      }
    } as unknown as Page

    await expect(waitForRestoredTerminalInputReady(page, 'pty-1', 500)).resolves.toBe(true)
    expect(pendingAttemptCounts).toEqual([0, 1, 0, 1])
    expect(firstInput).toHaveBeenCalledTimes(2)
    expect(replacementInput).toHaveBeenCalledTimes(1)
    expect(replacementInput.mock.calls[0]?.[0]).not.toBe(firstInput.mock.calls[1]?.[0])
  })
})
