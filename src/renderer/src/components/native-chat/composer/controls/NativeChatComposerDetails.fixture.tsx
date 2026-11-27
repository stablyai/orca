import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import { useAppStore } from '@/store'
import { nativeChatAppearanceStyle } from '../../appearance/native-chat-appearance-style'
import { NativeChatComposerField } from '../editor/NativeChatComposerField'
import { SettingsSwitchRow } from '../../../settings/form-controls/SettingsFormControls'
import {
  getChatBehaviorEntriesByKey,
  getChatBehaviorSearchEntries
} from '../../../settings/chat/chat-behavior-search'
import { NativeChatComposerDetails } from './NativeChatComposerDetails'
import { ChatSettingsSection } from '../../../settings/chat/ChatSettingsSection'
import { ActiveSettingsSectionProvider } from '../../../settings/section-layout/SettingsSection'
import { LOCAL_SETTINGS_HOST_SCOPE } from '../../../settings/host-scope/settings-host-scope'

const TAB = 'composer-details-tab'
const repo: Repo = {
  id: 'composer-details',
  path: '/preview/my-app',
  displayName: 'my-app',
  badgeColor: '',
  addedAt: 1,
  kind: 'git',
  executionHostId: 'local'
}
const workspace: Worktree = {
  id: `${repo.id}::${repo.path}`,
  repoId: repo.id,
  hostId: 'local',
  instanceId: 'composer-details-instance',
  path: repo.path,
  displayName: 'my-app',
  branch: 'feat/onboarding',
  head: 'a1b2c3d4e5f6',
  isBare: false,
  isMainWorktree: true,
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1
}
const noop = () => {}
const ime = { isComposing: () => false, ownsKeyDown: () => false, reset: noop, setComposing: noop }

function ComposerDetailsPreview(): React.JSX.Element {
  const shown = useAppStore((state) => state.settings?.nativeChatComposerDetails === true)
  const title = getChatBehaviorEntriesByKey().composerDetails.title
  return (
    <div className="flex flex-col gap-3">
      <div className="px-3">
        <SettingsSwitchRow
          label={title}
          checked={shown}
          onChange={() =>
            useAppStore.setState((state) => ({
              settings: state.settings && { ...state.settings, nativeChatComposerDetails: !shown }
            }))
          }
        />
      </div>
      <div
        data-native-chat-root=""
        className="native-chat-appearance flex h-56 flex-col justify-end bg-chat-canvas"
        style={nativeChatAppearanceStyle({})}
      >
        <p className="px-4 pb-2 text-sm text-chat-foreground">
          The onboarding checklist now opens on first launch.
        </p>
        <NativeChatComposerField
          draftScopeKey="fixture:composer-details"
          textareaRef={{ current: null }}
          draft=""
          disabled={false}
          hasPty
          canSend
          autocomplete={{ mode: 'none' }}
          mentionFiles={{ files: [], loading: false, failed: false }}
          activeSuggestion={0}
          notices={[]}
          imageAttachments={[]}
          sendButtonDisabled
          isWorking={false}
          hasDraft={false}
          attachDisabled={false}
          dictationDisabled={false}
          isDictating={false}
          isDictationHoldMode={false}
          imeEnterGesture={ime}
          onDraftChange={noop}
          onTextareaSelect={noop}
          onKeyDown={noop}
          onImeSettled={noop}
          onPaste={noop}
          pickerListboxId="fixture-composer-details-picker"
          onChoosePickerItem={noop}
          onRetrySkills={noop}
          onChooseMentionFile={noop}
          onRemoveImageAttachment={noop}
          onAttach={noop}
          onDictationToggle={noop}
          onDictationHoldStart={noop}
          onDictationHoldEnd={noop}
          onSend={noop}
          sessionOptionsSurface={null}
          sessionOptionsSnapshot={[]}
          workspaceFooter={<NativeChatComposerDetails terminalTabId={TAB} />}
        />
      </div>
    </div>
  )
}

// The row is a sibling under the card, so the field ends 16px (pb-4) below the card when it is off.
function checkRow(frame: HTMLElement, expectShown: boolean): void {
  const field = frame.querySelector<HTMLElement>('[data-composer-field]')
  const card = frame.querySelector<HTMLElement>('[data-native-chat-dock-pinned]')
  if (!field || !card) {
    throw new Error('The composer must render')
  }
  const row = field.querySelector('[class~="@container"]')
  if (Boolean(row) !== expectShown) {
    throw new Error(expectShown ? 'The details row must show' : 'The details row must not render')
  }
  const gap = field.getBoundingClientRect().bottom - card.getBoundingClientRect().bottom
  if (!expectShown && Math.abs(gap - 16) > 1) {
    throw new Error(`No band may stay under the composer when the row is off (gap ${gap}px)`)
  }
}

function detailsFixture(width: number, on: boolean, toggle = false) {
  return defineFixture({
    width,
    store: {
      repos: [repo],
      worktreesByRepo: { [repo.id]: [workspace] },
      unifiedTabsByWorktree: {
        [workspace.id]: [
          {
            id: TAB,
            entityId: 'composer-details-session',
            contentType: 'agent-session',
            agentSessionAgent: 'codex',
            worktreeId: workspace.id,
            groupId: 'preview',
            executionHostId: 'local',
            label: 'Chat',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    },
    setup: () => {
      useAppStore.setState((state) => ({
        settings: {
          ...getDefaultSettings('/home/fixture'),
          ...state.settings,
          machineName: 'Studio Mac',
          nativeChatComposerDetails: on
        }
      }))
    },
    render: () => <ComposerDetailsPreview />,
    interact: async (frame) => {
      checkRow(frame, on)
      if (toggle) {
        frame.querySelector<HTMLButtonElement>('[role="switch"]')?.click()
        await new Promise((resolve) => requestAnimationFrame(resolve))
        checkRow(frame, !on)
      }
    }
  })
}

export const off640 = detailsFixture(640, false)
export const on640 = detailsFixture(640, true)
export const off260 = detailsFixture(260, false)
export const on260 = detailsFixture(260, true)
export const turnedOn640 = detailsFixture(640, false, true)
export const turnedOff260 = detailsFixture(260, true, true)

function ChatSettingsSearchPreview(): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  return settings ? (
    <ActiveSettingsSectionProvider value="chat">
      <ChatSettingsSection
        settings={settings}
        updateSettings={updateSettings}
        writeSourceControlAiSettings={async () => {}}
        searchEntries={getChatBehaviorSearchEntries()}
        showDesktopOnlySettings
        hostScope={LOCAL_SETTINGS_HOST_SCOPE}
        isMounted
      />
    </ActiveSettingsSectionProvider>
  ) : null
}

// Settings > Chat UI searched for "composer": the switch sits beside spellcheck in Behavior.
export const inSettings = defineFixture({
  width: 820,
  store: { settingsSearchQuery: 'composer' },
  render: () => <ChatSettingsSearchPreview />
})
