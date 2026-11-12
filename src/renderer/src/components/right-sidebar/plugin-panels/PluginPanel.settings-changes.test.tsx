// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import PluginPanel from './PluginPanel'
import type { PluginSettingsChangeOrigin } from '../../../../../shared/plugins/workers/plugin-panel-bridge-protocol'

vi.mock('@/i18n/i18n', () => ({
  getIntlLocale: () => 'en-US',
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/store/plugins/catalog/plugin-contribution-catalog', () => ({
  usePluginPanels: () => [
    {
      id: 'tasks',
      title: 'Tasks',
      tabKey: 'plugin:acme.tasks/tasks',
      pluginKey: 'acme.tasks',
      pluginName: 'Acme Tasks'
    }
  ],
  usePluginPanelsStore: (select: (state: { setPanelHealth: () => void }) => unknown) =>
    select({ setPanelHealth: () => {} })
}))
afterEach(cleanup)

it('reports validated settings changes to the current host callback while forwarding them to the guest', async () => {
  let push: ((value: unknown) => void) | undefined
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      plugins: {
        readPanelEntry: async () => ({ html: '<main></main>', sessionToken: 's'.repeat(43) }),
        subscribePanelPush: (_token: string, listener: (value: unknown) => void) => {
          push = listener
          return () => {
            push = undefined
          }
        },
        onChanged: () => () => {}
      }
    }
  })
  const previous: [string, PluginSettingsChangeOrigin | undefined][] = []
  const current: [string, PluginSettingsChangeOrigin | undefined][] = []
  const { rerender } = render(
    <PluginPanel
      tabKey="plugin:acme.tasks/tasks"
      onSettingsChanged={(key, origin) => previous.push([key, origin])}
    />
  )
  const frame = await screen.findByTitle<HTMLIFrameElement>('Tasks')
  if (!frame.contentWindow) {
    throw new Error('The panel frame has no window.')
  }
  const posted = vi.spyOn(frame.contentWindow, 'postMessage')
  const changed = { kind: 'changed', area: 'settings', key: 'apiUrl', origin: 'plugin' }
  act(() => {
    push?.(changed)
  })
  expect(previous).toEqual([['apiUrl', 'plugin']])
  expect(posted).toHaveBeenCalledWith(
    {
      orca: 1,
      kind: 'evt',
      event: 'plugin.push',
      payload: changed
    },
    '*'
  )
  rerender(
    <PluginPanel
      tabKey="plugin:acme.tasks/tasks"
      onSettingsChanged={(key, origin) => current.push([key, origin])}
    />
  )
  act(() => {
    push?.({ kind: 'changed', area: 'storage', key: 'apiUrl' })
    push?.({ ...changed, origin: 'forged' })
    push?.({ ...changed, origin: 'settings-ui' })
    push?.({ kind: 'changed', area: 'settings', key: 'apiUrl' })
  })
  expect(current).toEqual([
    ['apiUrl', 'settings-ui'],
    ['apiUrl', undefined]
  ])
  expect(previous).toEqual([['apiUrl', 'plugin']])
})
