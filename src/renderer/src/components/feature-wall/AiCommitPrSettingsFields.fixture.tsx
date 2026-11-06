import { useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { AiCommitPrSettingsFields } from './AiCommitPrSettingsFields'
import { EMPTY_COMMIT_MESSAGE_AI_SETTINGS } from './ai-commit-pr-settings-helpers'
import { getCommitMessageAgentCapability } from '../../../../shared/source-control/ai/generation/commit-message-agent-spec'
import { aiCommitPrPickerEntry } from './ai-commit-pr-picker'
import {
  ON_DEVICE_TEXT_GENERATION_ID,
  type TextGenerationAgentId
} from '../../../../shared/on-device-text-generation'

function Harness({
  agentId,
  children
}: {
  agentId: TextGenerationAgentId
  children: (selectPortalRoot: HTMLElement | null) => React.ReactNode
}): React.JSX.Element {
  const [selectPortalRoot, setSelectPortalRoot] = useState<HTMLElement | null>(null)
  return (
    <div className="bg-background min-h-[520px] p-6">
      {children(selectPortalRoot)}
      <div ref={setSelectPortalRoot} className="relative" />
      <span className="sr-only">{agentId}</span>
    </div>
  )
}

function fields(agentId: TextGenerationAgentId, selectPortalRoot: HTMLElement | null) {
  const capability = getCommitMessageAgentCapability(agentId)
  if (!capability) {
    throw new Error(`no capability for ${agentId}`)
  }
  const pickerEntries = [
    aiCommitPrPickerEntry(capability, { ...EMPTY_COMMIT_MESSAGE_AI_SETTINGS, agentId })
  ]
  return (
    <AiCommitPrSettingsFields
      config={{ ...EMPTY_COMMIT_MESSAGE_AI_SETTINGS, agentId }}
      selectPortalRoot={selectPortalRoot}
      activeCapability={capability}
      isCustom={false}
      unsupportedAgentLabel={null}
      onAgentChange={() => {}}
      pickerEntries={pickerEntries}
      onPick={() => {}}
      writeConfig={() => {}}
    />
  )
}

/** Opens the agent dropdown so the option list is part of the capture. */
async function openAgentPicker(frame: HTMLElement): Promise<void> {
  frame.querySelector<HTMLElement>('[role="combobox"]')?.click()
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}

export const before = defineFixture({
  width: 520,
  setup: () => {
    window.api.platform.get = () => ({
      platform: 'win32',
      arch: 'x64',
      osRelease: '10.0',
      shell: 'powershell.exe',
      displayServer: null,
      windowMaterial: 'off',
      onDeviceModelInstalled: false
    })
  },
  interact: openAgentPicker,
  render: () => <Harness agentId="claude">{(root) => fields('claude', root)}</Harness>
})

export const after = defineFixture({
  width: 520,
  setup: () => {
    window.api.platform.get = () => ({
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '27.2',
      shell: '/bin/zsh',
      displayServer: null,
      windowMaterial: 'blur',
      onDeviceModelInstalled: true
    })
  },
  interact: openAgentPicker,
  render: () => (
    <Harness agentId={ON_DEVICE_TEXT_GENERATION_ID}>
      {(root) => fields(ON_DEVICE_TEXT_GENERATION_ID, root)}
    </Harness>
  )
})
