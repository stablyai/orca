import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import {
  nativeChatShowsCiResultLines,
  nativeChatShowsTurnDiffSummary
} from '../../../../../shared/native-chat/native-chat-appearance-settings'
import { useAppStore } from '../../../store/index'
import { Card, CardContent } from '../../ui/card'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSubsectionHeader, SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { matchesSettingsSearch } from '../search/settings-search'
import {
  getChatTurnActivityEntriesByKey,
  getChatTurnActivityTitle
} from './chat-turn-activity-search'
import { useTranslate } from '../../../i18n/use-translate'

/** What a turn did, shown under its reply: each switch also has a Hide on its card. */
export function ChatTurnActivitySetting({
  settings,
  updateSettings,
  forceVisible = false
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  forceVisible?: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const query = useAppStore((state) => state.settingsSearchQuery)
  const entries = getChatTurnActivityEntriesByKey()
  if (!forceVisible && !matchesSettingsSearch(query, Object.values(entries))) {
    return null
  }
  const turnDiffsShown = nativeChatShowsTurnDiffSummary(settings)
  const openedPullRequestsShown = settings.nativeChatOpenedPullRequests !== false
  const ciResultLinesShown = nativeChatShowsCiResultLines(settings)
  return (
    <section id="chat-turn-activity" className="space-y-3">
      <SettingsSubsectionHeader title={getChatTurnActivityTitle(t)} />
      <Card>
        <CardContent>
          <div className="divide-y divide-border/40">
            <SearchableSetting
              {...entries.turnDiffs}
              id={entries.turnDiffs.targetSectionId}
              forceVisible={forceVisible}
              className="max-w-none"
            >
              <SettingsSwitchRow
                label={entries.turnDiffs.title}
                description={entries.turnDiffs.description}
                checked={turnDiffsShown}
                ariaLabel={entries.turnDiffs.title}
                onChange={() => updateSettings({ nativeChatTurnDiffSummary: !turnDiffsShown })}
              />
            </SearchableSetting>
            <SearchableSetting
              {...entries.openedPullRequests}
              id={entries.openedPullRequests.targetSectionId}
              forceVisible={forceVisible}
              className="max-w-none"
            >
              <SettingsSwitchRow
                label={entries.openedPullRequests.title}
                description={entries.openedPullRequests.description}
                checked={openedPullRequestsShown}
                ariaLabel={entries.openedPullRequests.title}
                onChange={() =>
                  updateSettings({ nativeChatOpenedPullRequests: !openedPullRequestsShown })
                }
              />
            </SearchableSetting>
            <SearchableSetting
              {...entries.ciResultLines}
              id={entries.ciResultLines.targetSectionId}
              forceVisible={forceVisible}
              className="max-w-none"
            >
              <SettingsSwitchRow
                label={entries.ciResultLines.title}
                description={entries.ciResultLines.description}
                checked={ciResultLinesShown}
                ariaLabel={entries.ciResultLines.title}
                onChange={() => updateSettings({ nativeChatCiResultLines: !ciResultLinesShown })}
              />
            </SearchableSetting>
          </div>
        </CardContent>
      </Card>
    </section>
  )
}
