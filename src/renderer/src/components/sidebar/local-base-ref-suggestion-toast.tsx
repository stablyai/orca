import { toast } from 'sonner'
import type { AppState } from '@/store/types'
import type { LocalBaseRefUpdateSuggestion } from '../../../../shared/types'
import { Button } from '../ui/button'
import {
  KEEP_LOCAL_MAIN_UP_TO_DATE_SECTION_ID,
  getKeepLocalMainUpToDateTitle
} from '../settings/keep-local-main-up-to-date-setting'
import { translate } from '@/i18n/i18n'

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

// Why: sonner crams its built-in `action`/`cancel` buttons into the same
// center-aligned flex row as the title + multi-line description, which pinches
// the actions into a squished column. Rendering the body as a custom node lets
// the buttons sit in a full-width footer below the text while still reusing
// sonner's native frame (info icon, title, close X, swipe-to-dismiss).
function SuggestionToastBody({
  suggestion,
  deps
}: {
  suggestion: LocalBaseRefUpdateSuggestion
  deps: SuggestionToastDeps
}): React.JSX.Element {
  const { updateSettings, getSettings, openSettingsPage, openSettingsTarget } = deps
  const commitNoun =
    suggestion.behind === 1
      ? translate('auto.components.sidebar.local.base.ref.suggestion.toast.commit', 'commit')
      : translate('auto.components.sidebar.local.base.ref.suggestion.toast.commits', 'commits')
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
    // Why: opening Settings is informational, not a decline; Sonner still calls
    // onDismiss for this programmatic close, so skip the one-time decline flag.
    inspectSettingsDismissals.add(id)
    toast.dismiss(id)
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-popover-foreground/80">
        {translate(
          'auto.components.sidebar.local.base.ref.suggestion.toast.f15fd80989',
          'Your new worktree is current, but local {{value0}} is {{value1}} {{value2}} behind, so AI diffs may compare to stale history. Let Orca keep it up to date automatically. Change this anytime in',
          {
            value0: suggestion.localBranch,
            value1: suggestion.behind,
            value2: commitNoun
          }
        )}{' '}
        <button
          type="button"
          onClick={openSetting}
          className="cursor-pointer font-medium text-popover-foreground underline underline-offset-2 hover:text-primary"
        >
          {translate(
            'auto.components.sidebar.local.base.ref.suggestion.toast.3d260e1a5d',
            'Settings › {{value0}}',
            { value0: keepLocalMainUpToDateTitle }
          )}
        </button>
        .
      </p>
      <div className="flex justify-end">
        {/* No explicit Dismiss: the toast is persistent and sonner's close (X)
            already backs the user out and persists the decline. */}
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

  // Why (matches the sticky "Session restore failed" toast): stay on screen until
  // the user acts, so a ~4s auto-expire can't bury this one-time, opt-in nudge.
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
      // Fires for the close (X) button and swipe; the in-body buttons handle their
      // own dismissal since they are not sonner's native action/cancel controls.
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
