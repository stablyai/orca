import { useState } from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import { normalizeShellCommandWrapper } from '../../../../shared/shell-command-wrapper'
import { Input } from '../ui/input'
import { SettingsRow, SettingsSubsectionHeader } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { translate } from '@/i18n/i18n'

type TerminalShellCommandWrapperSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

type DraftState = {
  sourceValue: string
  draft: string
}

function createDraftState(sourceValue: string | undefined): DraftState {
  const normalized = sourceValue ?? ''
  return { sourceValue: normalized, draft: normalized }
}

function resolveDraftState(state: DraftState, sourceValue: string | undefined): DraftState {
  const nextSource = sourceValue ?? ''
  if (state.sourceValue === nextSource) {
    return state
  }
  // Why: external settings updates win only when the field is not mid-edit.
  if (state.draft === state.sourceValue) {
    return createDraftState(nextSource)
  }
  return { ...state, sourceValue: nextSource }
}

export function TerminalShellCommandWrapperSection({
  settings,
  updateSettings
}: TerminalShellCommandWrapperSectionProps): React.JSX.Element {
  const [draftState, setDraftState] = useState(() => createDraftState(settings.shellCommandWrapper))
  const resolved = resolveDraftState(draftState, settings.shellCommandWrapper)
  if (resolved !== draftState) {
    setDraftState(resolved)
  }

  const commit = (): void => {
    const normalized = normalizeShellCommandWrapper(resolved.draft) ?? ''
    setDraftState(createDraftState(normalized))
    if (normalized !== (settings.shellCommandWrapper ?? '')) {
      updateSettings({ shellCommandWrapper: normalized })
    }
  }

  return (
    <section key="shell-command-wrapper" className="space-y-3">
      <SettingsSubsectionHeader
        title={translate(
          'auto.components.settings.TerminalShellCommandWrapperSection.title',
          'Shell Command Wrapper'
        )}
        description={translate(
          'auto.components.settings.TerminalShellCommandWrapperSection.description',
          'Optional template that wraps agent and terminal launch commands so they run inside a project environment (for example devenv or nix-shell).'
        )}
      />

      <div className="divide-y divide-border/40">
        <SearchableSetting
          title={translate(
            'auto.components.settings.TerminalShellCommandWrapperSection.rowTitle',
            'Command Wrapper'
          )}
          description={translate(
            'auto.components.settings.TerminalShellCommandWrapperSection.rowDescription',
            'Use $CMD where the launch command should appear. Example: devenv shell -- $CMD'
          )}
          keywords={[
            'shell',
            'wrapper',
            'command',
            'devenv',
            'nix',
            'nix-shell',
            'environment',
            'launch',
            'agent',
            'template',
            '$CMD',
            'CMD'
          ]}
        >
          <SettingsRow
            alignTop
            label={translate(
              'auto.components.settings.TerminalShellCommandWrapperSection.rowTitle',
              'Command Wrapper'
            )}
            description={translate(
              'auto.components.settings.TerminalShellCommandWrapperSection.rowDescription',
              'Use $CMD where the launch command should appear. Example: devenv shell -- $CMD'
            )}
            control={
              <Input
                value={resolved.draft}
                onChange={(e) =>
                  setDraftState((current) => ({
                    ...resolveDraftState(current, settings.shellCommandWrapper),
                    draft: e.target.value
                  }))
                }
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    commit()
                    e.currentTarget.blur()
                  }
                  if (e.key === 'Escape') {
                    setDraftState(createDraftState(settings.shellCommandWrapper))
                    e.currentTarget.blur()
                  }
                }}
                placeholder="devenv shell -- $CMD"
                spellCheck={false}
                className="h-8 w-[min(28rem,100%)] font-mono text-xs"
                aria-label={translate(
                  'auto.components.settings.TerminalShellCommandWrapperSection.rowTitle',
                  'Command Wrapper'
                )}
              />
            }
          />
        </SearchableSetting>
      </div>
    </section>
  )
}
