import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultVoiceSettings } from '../../../../../shared/constants'
import { VoiceCodexVoiceModeSettings } from './VoiceCodexVoiceModeSettings'

// A slice of what codex-cli 0.165.0 lists under v3; fixtures only, the app reads Codex's own list.
const LISTED = ['cove', 'juniper', 'maple', 'spruce', 'ember', 'vale', 'breeze', 'arbor', 'sol']

function render(
  codexVoice: string | undefined,
  voices: readonly string[] | null,
  dictationEnabled = false
): () => React.JSX.Element {
  return () => (
    // The settings page's own shell sets its row density.
    <div className="settings-view-shell p-4">
      <div>
        <VoiceCodexVoiceModeSettings
          voiceSettings={{
            ...getDefaultVoiceSettings(),
            enabled: dictationEnabled,
            ...(codexVoice ? { codexVoice } : {})
          }}
          voices={voices}
          listing={false}
          onRefresh={() => {}}
          onUpdateVoiceSettings={() => {}}
        />
      </div>
    </div>
  )
}

/** Dictation off: the section needs no speech model. */
export const codexDefault = defineFixture({ width: 720, render: render(undefined, LISTED) })

export const chosenVoice = defineFixture({ width: 720, render: render('juniper', LISTED) })

export const voiceMenu = defineFixture({
  ...chosenVoice,
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button[role="combobox"]')?.click()
  }
})

/** No running Codex chat has listed its voices yet. */
export const unlisted = defineFixture({ width: 720, render: render(undefined, null) })

export const narrow = defineFixture({ width: 360, render: render('juniper', LISTED) })
