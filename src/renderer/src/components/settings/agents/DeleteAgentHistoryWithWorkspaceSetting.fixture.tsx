import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { useAppStore } from '@/store'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { DeleteAgentHistoryWithWorkspaceSetting } from './behavior/DeleteAgentHistoryWithWorkspaceSetting'

const settings = getDefaultSettings('/Users/test')

function Setting(): React.JSX.Element {
  const current = useAppStore((state) => state.settings) ?? settings
  return (
    <SettingsGroup>
      <DeleteAgentHistoryWithWorkspaceSetting
        hostScope={{ target: { kind: 'local' }, available: true }}
        settings={current}
      />
    </SettingsGroup>
  )
}

export const off = defineFixture({
  width: 640,
  store: { settings },
  render: () => <Setting />
})

export const confirm = defineFixture({
  width: 640,
  store: { settings },
  render: () => <Setting />,
  interact: async (frame) => {
    frame
      .querySelector<HTMLElement>(
        '[role="switch"][aria-label="Delete agent history when a workspace is deleted"]'
      )
      ?.click()
  }
})

function mockCodexHistorySize(): void {
  const call = window.api.runtime.call
  Object.assign(window.api, {
    runtime: {
      ...window.api.runtime,
      call: async ({ method }: { method: string }) =>
        method === 'workspaceCleanup.codexHistoryDiskUsage'
          ? {
              id: 'fixture',
              ok: true,
              result: { bytes: 53_500_000_000, rollouts: 41_905, complete: true }
            }
          : call({ method })
    }
  })
}

export const withCodexHistorySize = defineFixture({
  width: 640,
  store: { settings },
  setup: mockCodexHistorySize,
  render: () => <Setting />
})

export const codexHistorySizeTooltip = defineFixture({
  width: 640,
  store: { settings },
  setup: mockCodexHistorySize,
  render: () => <Setting />,
  // A Tab keydown first: tooltips open on keyboard focus, not on script focus alone.
  interact: async (frame) => {
    frame.ownerDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    frame.querySelector<HTMLElement>('[data-slot="tooltip-trigger"]')?.focus()
  }
})
