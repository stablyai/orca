import { toast } from 'sonner'
import { Trans } from 'react-i18next'
import type { AppState } from '@/store/types'
import type { LocalBaseRefUpdateSuggestion } from '../../../../shared/worktree/base-ref-drift-types'
import { Button } from '../ui/button'
import {
  KEEP_LOCAL_MAIN_UP_TO_DATE_SECTION_ID,
  getKeepLocalMainUpToDateTitle
} from '../settings/keep-local-main-up-to-date-setting'
import { i18n, translate } from '@/i18n/i18n'

type SuggestionToastDeps = {
  updateSettings: AppState['updateSettings']
  getSettings: () => AppState['settings']
  openSettingsPage: AppState['openSettingsPage']
  openSettingsTarget: AppState['openSettingsTarget']
}

function toastId(suggestion: LocalBaseRefUpdateSuggestion): string {
  return `local-base-ref-update-suggestion:${suggestion.baseRef}:${suggestion.localBranch}`
}

const inspectSettingsDismissals = new Set<string>()

// Use a custom body/footer so long text does not squeeze Sonner’s native action row.
function SuggestionToastBody({
  suggestion,
  deps
}: {
  suggestion: LocalBaseRefUpdateSuggestion
  deps: SuggestionToastDeps
}): React.JSX.Element {
  const { updateSettings, getSettings, openSettingsPage, openSettingsTarget } = deps
  const keepLocalMainUpToDateTitle = getKeepLocalMainUpToDateTitle()

  const turnOn = (): void => {
    void Promise.resolve(updateSettings({ refreshLocalBaseRefOnWorktreeCreate: true }))
      .then(() => {
        if (getSettings()?.refreshLocalBaseRefOnWorktreeCreate !== true) {
          throw new Error('settings_not_persisted')
        }
        toast.dismiss(toastId(suggestion))
        toast.success(
          translate(
            'auto.components.sidebar.local.base.ref.suggestion.toast.670864ab52',
            'Keeping local {{value0}} up to date',
            { value0: suggestion.localBranch }
          )
        )
      })
      .catch(() => {
        toast.error(
          translate(
            'auto.components.sidebar.local.base.ref.suggestion.toast.84c62e4d7f',
            'Could not turn on {{value0}}',
            { value0: keepLocalMainUpToDateTitle }
          ),
          {
            description: translate(
              'auto.components.sidebar.local.base.ref.suggestion.toast.442552c656',
              'Open Settings and try again.'
            )
          }
        )
      })
  }

  const openSetting = (): void => {
    const id = toastId(suggestion)
    openSettingsPage()
    openSettingsTarget({
      pane: 'git',
      repoId: null,
      sectionId: KEEP_LOCAL_MAIN_UP_TO_DATE_SECTION_ID
    })
    // Opening Settings is informational; suppress Sonner’s decline recording for this dismissal.
    inspectSettingsDismissals.add(id)
    toast.dismiss(id)
  }

  return (
    <div className="flex w-full flex-col gap-3">
      <p className="text-sm leading-5 text-popover-foreground/80">
        <Trans
          i18n={i18n}
          defaults={translate(
            'auto.components.sidebar.local.base.ref.suggestion.toast.staleLocalBranch',
            'Your new worktree is current, but local {{branch}} is {{count}} commits behind, so AI diffs may compare to stale history. Let Orca keep it up to date automatically. Change this anytime in <settings>Settings › {{setting}}</settings>',
            {
              count: suggestion.behind,
              defaultValue_one:
                'Your new worktree is current, but local {{branch}} is {{count}} commit behind, so AI diffs may compare to stale history. Let Orca keep it up to date automatically. Change this anytime in <settings>Settings › {{setting}}</settings>'
            }
          )}
          values={{
            branch: suggestion.localBranch,
            setting: keepLocalMainUpToDateTitle
          }}
          components={{
            settings: (
              <button
                type="button"
                onClick={openSetting}
                className="cursor-pointer font-medium text-popover-foreground underline underline-offset-2 hover:text-primary"
              />
            )
          }}
        />
      </p>
      <div className="flex justify-end">
        {/* Sonner’s close button already persists decline; no additional dismiss action is needed. */}
        <Button size="sm" onClick={turnOn}>
          {translate(
            'auto.components.sidebar.local.base.ref.suggestion.toast.34a03a6565',
            'Keep {{value0}} up to date',
            { value0: suggestion.localBranch }
          )}
        </Button>
      </div>
    </div>
  )
}

export function showLocalBaseRefUpdateSuggestionToast(
  suggestion: LocalBaseRefUpdateSuggestion | undefined,
  deps: SuggestionToastDeps
): void {
  if (!suggestion) {
    return
  }

  // Keep this one-time opt-in prompt visible until the user acts.
  toast.info(
    translate(
      'auto.components.sidebar.local.base.ref.suggestion.toast.4a18052018',
      'Local {{value0}} is behind {{value1}}',
      { value0: suggestion.localBranch, value1: suggestion.baseRef }
    ),
    {
      id: toastId(suggestion),
      description: <SuggestionToastBody suggestion={suggestion} deps={deps} />,
      duration: Infinity,
      dismissible: true,
      // Close/swipe uses onDismiss; custom body actions handle their own dismissal.
      onDismiss: () => {
        if (inspectSettingsDismissals.delete(toastId(suggestion))) {
          return
        }
        if (deps.getSettings()?.refreshLocalBaseRefOnWorktreeCreate === true) {
          return
        }
        void Promise.resolve(deps.updateSettings({ localBaseRefSuggestionDismissed: true })).catch(
          () => {}
        )
      }
    }
  )
}
