import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { getDefaultSettings } from '../../../../shared/constants'
import { BrowserLinkRoutingSetting } from './BrowserLinkRoutingSetting'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

vi.mock('../ui/select', () => ({
  Select: ({
    value,
    disabled,
    children
  }: {
    value: string
    disabled?: boolean
    children: React.ReactNode
  }) => (
    <div
      data-slot="browser-tab-host-select"
      data-value={value}
      data-disabled={String(Boolean(disabled))}
    >
      {children}
    </div>
  ),
  SelectTrigger: ({
    children,
    size: _size,
    ...props
  }: React.ComponentProps<'button'> & { size?: string }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { value: string; children: React.ReactNode }) => <div>{children}</div>
}))

const webClientFlag = globalThis as { __ORCA_WEB_CLIENT__?: boolean }

afterEach(() => {
  delete webClientFlag.__ORCA_WEB_CLIENT__
})

describe('BrowserLinkRoutingSetting', () => {
  it('keeps the desktop browser host selectable', () => {
    const settings = getDefaultSettings('/tmp')
    const markup = renderToStaticMarkup(
      <BrowserLinkRoutingSetting
        settings={settings}
        linkRoutingDescription="Choose how links open."
        isMac={false}
        updateSettings={vi.fn()}
      />
    )

    expect(markup).toContain('data-value="local"')
    expect(markup).toContain('data-disabled="false"')
  })

  it('shows the effective workspace host and locks it in paired web clients', () => {
    webClientFlag.__ORCA_WEB_CLIENT__ = true
    const settings = { ...getDefaultSettings('/tmp'), browserTabHost: 'local' as const }
    const markup = renderToStaticMarkup(
      <BrowserLinkRoutingSetting
        settings={settings}
        linkRoutingDescription="Choose how links open."
        isMac={false}
        updateSettings={vi.fn()}
      />
    )

    expect(markup).toContain('data-value="workspace"')
    expect(markup).toContain('data-disabled="true"')
  })
})
