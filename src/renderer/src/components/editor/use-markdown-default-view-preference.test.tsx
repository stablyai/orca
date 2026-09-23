// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { RichMarkdownContextMenuCommandPayload } from '../../../../shared/rich-markdown-context-menu'
import { useMarkdownDefaultViewPreference } from './use-markdown-default-view-preference'

let listener: ((payload: RichMarkdownContextMenuCommandPayload) => void) | null = null
const setMarkdownDefaultViewMode = vi.fn()
const updateSettings = vi.fn()

function Harness(): null {
  useMarkdownDefaultViewPreference()
  return null
}

function setSettings(settings: Partial<GlobalSettings> | null): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only markdownDefaultViewMode off settings.
  useAppStore.setState({ settings: settings as GlobalSettings | null, updateSettings })
}

beforeEach(() => {
  listener = null
  setMarkdownDefaultViewMode.mockReset()
  updateSettings.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: {
        setMarkdownDefaultViewMode,
        onRichMarkdownContextCommand: vi.fn((callback) => {
          listener = callback
          return () => {
            listener = null
          }
        })
      }
    }
  })
})

afterEach(() => {
  cleanup()
  setSettings(null)
})

describe('useMarkdownDefaultViewPreference', () => {
  it('mirrors the persisted preference into main once settings hydrate', () => {
    setSettings(null)
    render(<Harness />)
    expect(setMarkdownDefaultViewMode).not.toHaveBeenCalled()

    act(() => setSettings({ markdownDefaultViewMode: 'preview' }))
    expect(setMarkdownDefaultViewMode).toHaveBeenLastCalledWith('preview')
  })

  it('mirrors the rich-editor default for profiles saved before the preference existed', () => {
    setSettings({})
    render(<Harness />)

    expect(setMarkdownDefaultViewMode).toHaveBeenLastCalledWith('rich')
  })

  it('persists the view a native context-menu command selected', () => {
    setSettings({ markdownDefaultViewMode: 'rich' })
    render(<Harness />)

    act(() => listener?.({ command: 'default-view-source', x: 1, y: 2 }))

    expect(updateSettings).toHaveBeenCalledWith({ markdownDefaultViewMode: 'source' })
  })

  it('ignores commands the rich editor owns', () => {
    setSettings({ markdownDefaultViewMode: 'rich' })
    render(<Harness />)

    act(() => listener?.({ command: 'bold', x: 1, y: 2 }))

    expect(updateSettings).not.toHaveBeenCalled()
  })
})
