import { useRef, useState } from 'react'
import type React from 'react'
import type { Repo } from '../../../../shared/repo-types'
import {
  buildRepoTerminalThemeUpdate,
  type RepoTerminalThemeOverrides,
  type RepoTerminalThemeVariant
} from '../../../../shared/repo-terminal-theme'
import { useAppStore } from '../../store'
import { useSystemPrefersDark } from '../terminal-pane/use-system-prefers-dark'
import { Button } from '../ui/button'
import {
  applyRepoTerminalThemeOverride,
  getAvailableTerminalThemeOptions,
  getTerminalTheme,
  resolveEffectiveTerminalAppearance
} from '@/lib/terminal-theme'
import { translate } from '@/i18n/i18n'
import { getRepositoryTerminalThemeSectionId } from './repository-settings-targets'
import { getSettingOwnershipSummary } from './setting-ownership'
import { SettingsSegmentedControl, ThemePicker } from './SettingsFormControls'
import { TerminalSettingsPreview } from './TerminalSettingsPreview'

type RepositoryTerminalThemeSectionProps = {
  repo: Repo
  updateRepo: (
    repoId: string,
    updates: { terminalTheme: RepoTerminalThemeOverrides | null }
  ) => void | Promise<boolean>
}

// Why: optimistic override so back-to-back picks build on the last sent value, not the stale prop.
type RepoTerminalThemeDraft = { repoId: string; value: RepoTerminalThemeOverrides | undefined }

// Why scoped: the section is not keyed by project, so a rejection must not follow the user elsewhere.
type RepoTerminalThemeSaveError = { repoId: string; variant: RepoTerminalThemeVariant }

// Why: tells the caption whether the shown theme is the global one, a missing saved one, or mirrored repo dark.
type RepoTerminalThemeOverrideState =
  | 'override'
  | 'stale-override'
  | 'mirrors-repo-dark'
  | 'inherit'

export function RepositoryTerminalThemeSection({
  repo,
  updateRepo
}: RepositoryTerminalThemeSectionProps): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const systemPrefersDark = useSystemPrefersDark()
  const [target, setTarget] = useState<RepoTerminalThemeVariant | null>(null)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<RepoTerminalThemeDraft | null>(null)
  const [unstorablePick, setUnstorablePick] = useState<RepoTerminalThemeSaveError | null>(null)
  const [failedSave, setFailedSave] = useState<RepoTerminalThemeSaveError | null>(null)
  // Why: a project's picks settle in order, so only its newest may report; older refusals are superseded.
  const latestSaveByRepoRef = useRef(new Map<string, RepoTerminalThemeDraft>())

  if (!settings) {
    return null
  }

  // Why: default to the active terminal mode so the first pick applies to what the user sees now.
  const activeTarget =
    target ?? resolveEffectiveTerminalAppearance(settings, systemPrefersDark).mode
  const override = draft?.repoId === repo.id ? draft.value : repo.terminalTheme
  const themeNameFor = (resolved: typeof settings): string =>
    resolveEffectiveTerminalAppearance({ ...resolved, theme: activeTarget }, systemPrefersDark)
      .themeName
  const merged = applyRepoTerminalThemeOverride(settings, override)
  const effectiveName = themeNameFor(merged)
  const globalName = themeNameFor(settings)
  const themeOptions = getAvailableTerminalThemeOptions(settings)
  const labelFor = (name: string): string =>
    themeOptions.find((option) => option.value === name)?.label ?? name
  const storedSelection = override?.[activeTarget]
  const overrideState: RepoTerminalThemeOverrideState =
    storedSelection !== undefined
      ? getTerminalTheme(settings, storedSelection)
        ? 'override'
        : 'stale-override'
      : effectiveName !== globalName
        ? 'mirrors-repo-dark'
        : 'inherit'
  const isLightTarget = activeTarget === 'light'
  const ownership = getSettingOwnershipSummary('repositoryTerminalTheme')
  const sectionId = getRepositoryTerminalThemeSectionId(repo.id)
  const pickerTitle = isLightTarget
    ? translate('auto.components.settings.TerminalThemeSections.8273bc75d7', 'Light Theme')
    : translate('auto.components.settings.TerminalThemeSections.9499ad1dc4', 'Dark Theme')
  const pickerDescription = isLightTarget
    ? translate(
        'auto.components.settings.RepositoryTerminalThemeSection.lightDescription',
        'Terminal theme for this project when Orca is in light mode.'
      )
    : translate(
        'auto.components.settings.RepositoryTerminalThemeSection.darkDescription',
        'Terminal theme for this project when Orca is in dark mode.'
      )

  const showUnstorablePick =
    unstorablePick?.repoId === repo.id && unstorablePick.variant === activeTarget

  const showFailedSave = failedSave?.repoId === repo.id && failedSave.variant === activeTarget

  const saveSelection = (selection: string | null): void => {
    const update = buildRepoTerminalThemeUpdate(override, activeTarget, selection)
    if (update.kind === 'rejected') {
      setUnstorablePick({ repoId: repo.id, variant: activeTarget })
      setFailedSave(null)
      return
    }
    setUnstorablePick(null)
    setFailedSave(null)
    const variant = activeTarget
    const next = update.terminalTheme
    const nextDraft: RepoTerminalThemeDraft = { repoId: repo.id, value: next ?? undefined }
    setDraft(nextDraft)
    latestSaveByRepoRef.current.set(repo.id, nextDraft)
    // Why: drop the draft once the latest write settles; the store has refreshed `repo` by then.
    void Promise.resolve(updateRepo(repo.id, { terminalTheme: next }))
      // Why: only an explicit false is a refusal; void-returning callers stay silent.
      .then((saved) => saved === false)
      .catch(() => true)
      .then((refused) => {
        if (latestSaveByRepoRef.current.get(repo.id) !== nextDraft) {
          return
        }
        const sameRepo = (current: RepoTerminalThemeSaveError | null): boolean =>
          current?.repoId === repo.id
        if (!refused) {
          setFailedSave((current) => (sameRepo(current) ? null : current))
          return
        }
        setFailedSave({ repoId: repo.id, variant })
        // Why: one destructive caption at a time; the newest outcome wins.
        setUnstorablePick((current) => (sameRepo(current) ? null : current))
      })
      .finally(() => {
        setDraft((current) => (current === nextDraft ? null : current))
      })
  }

  const caption =
    overrideState === 'stale-override'
      ? translate(
          'auto.components.settings.RepositoryTerminalThemeSection.staleOverride',
          'Saved theme {{value0}} is no longer available. Using global: {{value1}}',
          { value0: storedSelection ?? '', value1: labelFor(globalName) }
        )
      : overrideState === 'mirrors-repo-dark'
        ? translate(
            'auto.components.settings.RepositoryTerminalThemeSection.mirrorsRepoDark',
            "Follows this project's dark theme: {{value0}}",
            { value0: labelFor(effectiveName) }
          )
        : overrideState === 'inherit'
          ? translate(
              'auto.components.settings.RepositoryTerminalThemeSection.usingGlobal',
              'Using global: {{value0}}',
              { value0: labelFor(globalName) }
            )
          : null
  const canReset = overrideState === 'override' || overrideState === 'stale-override'

  return (
    <section id={sectionId} data-settings-section={sectionId} className="space-y-4">
      <div className="min-w-0 space-y-1">
        <h3 className="text-sm font-semibold">
          {translate(
            'auto.components.settings.RepositoryTerminalThemeSection.title',
            'Terminal Theme'
          )}
        </h3>
        <p className="text-xs text-muted-foreground">{ownership.description}</p>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">
          {translate('auto.components.settings.TerminalThemeSections.target_title', 'Theme Mode')}
        </p>
        <SettingsSegmentedControl
          value={activeTarget}
          onChange={setTarget}
          ariaLabel={translate(
            'auto.components.settings.TerminalThemeSections.target_aria',
            'Terminal theme mode'
          )}
          equalWidth
          options={[
            {
              value: 'dark',
              label: translate('auto.components.settings.TerminalThemeSections.target_dark', 'Dark')
            },
            {
              value: 'light',
              label: translate(
                'auto.components.settings.TerminalThemeSections.target_light',
                'Light'
              )
            }
          ]}
        />
      </div>

      <div className="space-y-3">
        <ThemePicker
          label={pickerTitle}
          description={pickerDescription}
          selectedTheme={effectiveName}
          themeOptions={themeOptions}
          query={query}
          onQueryChange={setQuery}
          onSelectTheme={saveSelection}
        />
        {showUnstorablePick ? (
          <p className="text-[11px] text-destructive">
            {translate(
              'auto.components.settings.RepositoryTerminalThemeSection.unstorableSelection',
              'This theme name is too long to save for a project. Rename the theme and try again.'
            )}
          </p>
        ) : null}
        {showFailedSave ? (
          <p className="text-[11px] text-destructive">
            {translate(
              'auto.components.settings.RepositoryTerminalThemeSection.saveFailed',
              'Could not save this theme for the project. Try again.'
            )}
          </p>
        ) : null}
        {caption ? <p className="text-[11px] text-muted-foreground">{caption}</p> : null}
        {canReset ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => saveSelection(null)}>
            {translate(
              'auto.components.settings.RepositoryTerminalThemeSection.useGlobal',
              'Use global'
            )}
          </Button>
        ) : null}
      </div>

      <TerminalSettingsPreview
        title={
          isLightTarget
            ? translate(
                'auto.components.settings.TerminalThemeSections.db210115c5',
                'Light Mode Preview'
              )
            : translate(
                'auto.components.settings.TerminalThemeSections.bc8e8a251a',
                'Dark Mode Preview'
              )
        }
        settings={merged}
        systemPrefersDark={systemPrefersDark}
        modeOverride={activeTarget}
      />
    </section>
  )
}
