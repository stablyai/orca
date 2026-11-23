// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { buildHttpLinkActions } from '@/lib/browser/navigation/http-link-destinations'
import { BROWSER_TERMINAL_LINK_ACTIONS_SETTINGS_TARGET_ID } from '@/components/settings/navigation/settings-navigation-types'
import { LinkActionPopover } from './LinkActionPopover'
import type { LinkActionKind, LinkActionRequest } from './link-action-request'

const { openLinkSettings, webClient } = vi.hoisted(() => ({
  openLinkSettings: vi.fn(),
  webClient: { value: false }
}))

vi.mock('@/lib/links/preferences/link-preference-notice', () => ({
  openLinkSettings
}))
vi.mock('@/app-shell/platform/web-client-location', () => ({
  isWebClientLocation: () => webClient.value
}))

const openSettingsTarget = vi.fn()
const openSettingsPage = vi.fn()

beforeEach(() => {
  webClient.value = false
  useAppStore.setState({ openSettingsTarget, openSettingsPage })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

function request(kind: LinkActionKind, extra: Partial<LinkActionRequest> = {}): LinkActionRequest {
  return {
    anchorX: 10,
    anchorY: 10,
    destination: kind === 'file' ? '/tmp/notes.md' : 'https://example.com/docs',
    kind,
    ...buildHttpLinkActions({ primary: 'system', alternate: 'orca' }, () => {}),
    restoreFocus: () => {},
    ...extra
  }
}

function renderChooser(req: LinkActionRequest): void {
  render(
    <TooltipProvider>
      <LinkActionPopover request={req} onClose={() => {}} onOpenSettings={() => {}} />
    </TooltipProvider>
  )
}

// Sidebar and activity choosers carry no linkPreferenceHost, yet their web links follow the same setting.
it.each([
  ['a chat, terminal or dashboard chooser', { linkPreferenceHost: true }],
  ['a sidebar chooser', {}]
])('sends the gear of %s to the app-wide Links settings', (_label, extra) => {
  renderChooser(request('url', extra))
  fireEvent.click(screen.getByRole('button', { name: 'Link settings' }))
  expect(openLinkSettings).toHaveBeenCalledTimes(1)
  expect(openSettingsTarget).not.toHaveBeenCalled()
})

it('keeps file-path choosers on the terminal click settings', () => {
  renderChooser(request('file'))
  fireEvent.click(screen.getByRole('button', { name: 'Terminal link settings' }))
  expect(openLinkSettings).not.toHaveBeenCalled()
  expect(openSettingsTarget).toHaveBeenCalledWith({
    pane: 'browser',
    repoId: null,
    sectionId: BROWSER_TERMINAL_LINK_ACTIONS_SETTINGS_TARGET_ID
  })
})

it('keeps the web client, which has no Open links control, on the terminal click settings', () => {
  webClient.value = true
  renderChooser(request('url'))
  fireEvent.click(screen.getByRole('button', { name: 'Terminal link settings' }))
  expect(openLinkSettings).not.toHaveBeenCalled()
  expect(openSettingsTarget).toHaveBeenCalledTimes(1)
})
