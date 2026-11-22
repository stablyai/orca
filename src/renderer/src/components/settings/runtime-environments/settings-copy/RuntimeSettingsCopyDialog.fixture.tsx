import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { SettingsCopyPreview } from './settings-copy'
import { RuntimeSettingsCopyDialog } from './RuntimeSettingsCopyDialog'
import type { SettingsCopyController, SettingsCopyState } from './use-settings-copy'

const preview: SettingsCopyPreview = {
  settings: {},
  changed: ['terminalFontSize', 'terminalThemeDark', 'editorWordWrap', 'diffDefaultView'],
  skipped: [],
  notSent: ['terminalThemeLight'],
  pairingRevision: 1
}

function controller(
  state: SettingsCopyState,
  direction: SettingsCopyController['direction'] = 'send'
): SettingsCopyController {
  return {
    open: true,
    direction,
    state,
    start: () => {},
    chooseDirection: () => {},
    retry: () => {},
    apply: () => {},
    close: () => {}
  }
}

function fixture(copy: SettingsCopyController): ReturnType<typeof defineFixture> {
  return defineFixture({
    width: 640,
    render: () => (
      <div className="h-[460px] bg-background">
        <RuntimeSettingsCopyDialog name="Build server" copy={copy} />
      </div>
    )
  })
}

export const settingsCopyPreview = fixture(controller({ phase: 'ready', preview }))

export const settingsCopyReceive = fixture(
  controller(
    {
      phase: 'ready',
      preview: { ...preview, changed: ['theme'], notSent: [], skipped: ['uiLanguage'] }
    },
    'receive'
  )
)

export const settingsCopyApplied = fixture(
  controller({ phase: 'applied', preview, result: { changed: preview.changed, skipped: [] } })
)

export const settingsCopyUnsupported = fixture(
  controller({
    phase: 'failed',
    message: 'Unknown method',
    unsupported: true,
    pairingChanged: false
  })
)
