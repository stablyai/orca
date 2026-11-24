import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { setRendererUiLanguage } from '@/i18n/i18n'
import { NativeChatPermissionModePicker } from '../../../native-chat/session/options/controls/NativeChatPermissionModePicker'
import { AllAgentsPermissionSetting } from './AllAgentsPermissionSetting'
import { AgentPermissionModeMenu } from './AgentPermissionModeMenu'

const noop = (): void => {}

/** Opens the first menu like a mouse press; optionally focuses a row so its tooltip shows. */
async function openMenu(frame: HTMLElement, focusRow?: string): Promise<void> {
  frame
    .querySelector('button[aria-haspopup="menu"]')
    ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }))
  await new Promise(requestAnimationFrame)
  await new Promise(requestAnimationFrame)
  if (focusRow) {
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
      .find((row) => row.textContent?.startsWith(focusRow))
      ?.focus()
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

function Settings() {
  return (
    <div className="h-[300px] p-4">
      <AllAgentsPermissionSetting
        chatOwnSupported
        choice="auto"
        withoutAutoChoice="own"
        onChange={noop}
        onChangeWithoutAuto={noop}
      />
    </div>
  )
}

function LegacyHost({ autoDisabled }: { autoDisabled?: boolean }) {
  return (
    <div className="h-[220px] p-4">
      <AgentPermissionModeMenu
        mode={autoDisabled ? 'manual' : 'auto'}
        label="Agent permissions"
        autoAvailable
        autoDisabled={autoDisabled}
        onChange={noop}
      />
    </div>
  )
}

export const settingsMenu = defineFixture({
  width: 800,
  render: () => <Settings />,
  interact: (frame) => openMenu(frame)
})

export const settingsMenuTooltip = defineFixture({
  width: 800,
  render: () => <Settings />,
  interact: (frame) => openMenu(frame, "Each agent's own settings")
})

export const settingsRussianTooltip = defineFixture({
  width: 800,
  render: () => <Settings />,
  interact: async (frame) => {
    await setRendererUiLanguage('ru')
    await openMenu(frame, 'Собственные')
  }
})

export const legacyHost = defineFixture({
  width: 800,
  render: () => <LegacyHost />
})

export const legacyHostAutoDisabled = defineFixture({
  width: 800,
  render: () => <LegacyHost autoDisabled />,
  interact: (frame) => openMenu(frame, 'Approve for me')
})

export const composerMenu = defineFixture({
  width: 800,
  render: () => (
    <div className="flex h-[260px] items-end p-4">
      <NativeChatPermissionModePicker
        current="ask"
        modes={['ask', 'accept-edits', 'auto', 'full-access']}
        agent="claude"
        onSelect={noop}
      />
    </div>
  ),
  interact: (frame) => openMenu(frame, 'Accept edits')
})
