// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dashboardNativeChatPtyWriter } from './dashboard-native-chat-pty-writer'

const input = vi.fn<() => Promise<boolean>>()

beforeEach(() => {
  input.mockReset()
  ;(window as unknown as { api: unknown }).api = { terminalPreview: { input } }
})

describe('dashboardNativeChatPtyWriter', () => {
  it('serializes writes through the terminal-preview authorization lane', async () => {
    let releaseFirst!: (accepted: boolean) => void
    input
      .mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          releaseFirst = resolve
        })
      )
      .mockResolvedValueOnce(true)

    expect(dashboardNativeChatPtyWriter.write(null, 'pty-1', 'body')).toBe(true)
    const submit = dashboardNativeChatPtyWriter.writeAccepted(null, 'pty-1', '\r')
    await Promise.resolve()
    expect(input).toHaveBeenCalledTimes(1)

    releaseFirst(true)
    await expect(submit).resolves.toBe(true)
    expect(input.mock.calls).toEqual([
      ['pty-1', 'body'],
      ['pty-1', '\r']
    ])
  })

  it('reports a refused preview write to verified callers', async () => {
    input.mockResolvedValue(false)

    await expect(dashboardNativeChatPtyWriter.writeAccepted(null, 'pty-2', 'answer')).resolves.toBe(
      false
    )
  })
})
