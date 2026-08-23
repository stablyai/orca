import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { GeneralPane } from './GeneralPane'

const mocks = vi.hoisted(() => ({ cliProps: [] as Record<string, unknown>[] }))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settingsSearchQuery: '',
      worktreeVisibilityDefaultsSupportedRuntimeEnvironmentId: undefined,
      worktreeVisibilitySourceDefaultsSupportedRuntimeEnvironmentId: undefined
    })
}))

vi.mock('./CliSection', () => ({
  CliSection: (props: Record<string, unknown>) => {
    mocks.cliProps.push(props)
    return null
  }
}))

vi.mock('./GeneralEditorSettingsSection', () => ({ GeneralEditorSettingsSection: () => null }))
vi.mock('./GeneralSupportSection', () => ({ GeneralSupportSection: () => null }))
vi.mock('./GeneralUpdateSettingsSection', () => ({ GeneralUpdateSettingsSection: () => null }))
vi.mock('./GeneralWorkspaceSettingsSection', () => ({
  GeneralWorkspaceSettingsSection: () => null
}))
vi.mock('./RecentTabOrderControl', () => ({ RecentTabOrderControl: () => null }))
vi.mock('./SearchableSetting', () => ({ SearchableSetting: () => null }))
vi.mock('./SettingsFormControls', () => ({
  SettingsSubsectionHeader: () => null,
  SettingsSwitchRow: () => null
}))
vi.mock('./DefaultWindowsProjectRuntimeSetting', () => ({
  DefaultWindowsProjectRuntimeSetting: () => null
}))

describe('GeneralPane CLI platform propagation', () => {
  beforeEach(() => {
    mocks.cliProps.length = 0
  })

  it('keeps registration viewer-owned while skill setup receives the execution host', () => {
    renderToStaticMarkup(
      <GeneralPane
        settings={getDefaultSettings('/tmp')}
        updateSettings={vi.fn()}
        fontSuggestions={[]}
        viewerPlatform="win32"
        executionHostRuntime={{
          runtime: 'host',
          hostPlatform: 'linux',
          terminalWindowsShell: undefined,
          label: 'This device'
        }}
        wslSupportedPlatform={false}
      />
    )

    expect(mocks.cliProps).toContainEqual(
      expect.objectContaining({
        currentPlatform: 'win32',
        executionHostRuntime: expect.objectContaining({
          hostPlatform: 'linux',
          terminalWindowsShell: undefined
        }),
        wslSupportedPlatform: false
      })
    )
  })
})
