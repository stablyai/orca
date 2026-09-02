import { useId, useRef } from 'react'
import { Plus, X } from 'lucide-react'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import {
  normalizeCustomAgentProfile,
  type CustomAgentProfile
} from '../../../../shared/custom-agent-profile'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../shared/tui-agent-display-names'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { AgentRowAction } from './AgentSettingsRow'

export type CustomAgentEditorState = {
  originalId: string | null
  profile: CustomAgentProfile
}

type DraftErrors = Partial<Record<'name' | 'executable' | 'profile', string>>

export function validateCustomAgentDraft(
  draft: CustomAgentProfile,
  profiles: readonly CustomAgentProfile[],
  catalog: readonly AgentCatalogEntry[],
  originalId: string | null
): DraftErrors {
  const errors: DraftErrors = {}
  if (!draft.name.trim()) {
    errors.name = translate(
      'auto.components.settings.CustomAgentProfilesSection.nameRequired',
      'Enter a name.'
    )
  } else {
    const folded = draft.name.trim().toLowerCase()
    const reserved = new Set([
      ...Object.keys(TUI_AGENT_DISPLAY_NAMES).map((value) => value.toLowerCase()),
      ...Object.values(TUI_AGENT_DISPLAY_NAMES).map((value) => value.toLowerCase()),
      ...catalog.map((entry) => entry.label.trim().toLowerCase())
    ])
    if (
      reserved.has(folded) ||
      profiles.some((profile) => profile.id !== originalId && profile.name.toLowerCase() === folded)
    ) {
      errors.name = translate(
        'auto.components.settings.CustomAgentProfilesSection.nameUnique',
        'Choose a name that is not already used by another agent.'
      )
    }
  }
  if (!draft.executable.trim()) {
    errors.executable = translate(
      'auto.components.settings.CustomAgentProfilesSection.executableRequired',
      'Enter an executable name or path.'
    )
  }
  if (!normalizeCustomAgentProfile(draft)) {
    errors.profile = translate(
      'auto.components.settings.CustomAgentProfilesSection.invalidProfile',
      'The name, executable, and arguments must be literal text without control characters.'
    )
  }
  return errors
}

export function CustomAgentProfileEditor({
  editor,
  catalog,
  profiles,
  saving,
  persistenceError,
  nameInputRef,
  onChange,
  onSave,
  onCancel
}: {
  editor: CustomAgentEditorState
  catalog: readonly AgentCatalogEntry[]
  profiles: readonly CustomAgentProfile[]
  saving: boolean
  persistenceError: string | null
  nameInputRef: React.RefObject<HTMLInputElement | null>
  onChange: (profile: CustomAgentProfile) => void
  onSave: () => void
  onCancel: () => void
}): React.JSX.Element {
  const { profile } = editor
  const errors = validateCustomAgentDraft(profile, profiles, catalog, editor.originalId)
  const argumentsId = useId()
  const nameErrorId = `${profile.id}-name-error`
  const executableErrorId = `${profile.id}-executable-error`
  const argumentInputRefs = useRef<(HTMLInputElement | null)[]>([])
  const addArgumentRef = useRef<HTMLButtonElement | null>(null)
  const argumentIdsRef = useRef(profile.args.map((_, index) => `${profile.id}-argument-${index}`))
  const nextArgumentIdRef = useRef(profile.args.length)
  const setArgs = (args: string[]): void => onChange({ ...profile, args })
  const addArgument = (): void => {
    argumentIdsRef.current.push(`${profile.id}-argument-${nextArgumentIdRef.current++}`)
    setArgs([...profile.args, ''])
  }
  const removeArgument = (index: number): void => {
    const next = profile.args.filter((_, argIndex) => argIndex !== index)
    argumentIdsRef.current.splice(index, 1)
    setArgs(next)
    requestAnimationFrame(() => {
      if (next.length === 0) {
        addArgumentRef.current?.focus()
      } else {
        argumentInputRefs.current[Math.min(index, next.length - 1)]?.focus()
      }
    })
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        onSave()
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor={`${profile.id}-name`}>
          {translate('auto.components.settings.CustomAgentProfileEditor.name', 'Name')}
        </Label>
        <Input
          ref={nameInputRef}
          id={`${profile.id}-name`}
          value={profile.name}
          onChange={(event) => onChange({ ...profile, name: event.target.value })}
          aria-invalid={Boolean(errors.name)}
          aria-describedby={errors.name ? nameErrorId : undefined}
        />
        {errors.name ? (
          <p id={nameErrorId} className="text-xs text-destructive">
            {errors.name}
          </p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${profile.id}-executable`}>
          {translate('auto.components.settings.CustomAgentProfileEditor.executable', 'Executable')}
        </Label>
        <Input
          id={`${profile.id}-executable`}
          value={profile.executable}
          placeholder={translate(
            'auto.components.settings.CustomAgentProfileEditor.executablePlaceholder',
            'codex'
          )}
          onChange={(event) => onChange({ ...profile, executable: event.target.value })}
          aria-invalid={Boolean(errors.executable)}
          aria-describedby={errors.executable ? executableErrorId : undefined}
        />
        {errors.executable ? (
          <p id={executableErrorId} className="text-xs text-destructive">
            {errors.executable}
          </p>
        ) : null}
      </div>

      <div className="space-y-2" role="group" aria-labelledby={argumentsId}>
        <div className="flex items-center justify-between gap-2">
          <Label id={argumentsId}>
            {translate('auto.components.settings.CustomAgentProfileEditor.arguments', 'Arguments')}
          </Label>
          <Button
            ref={addArgumentRef}
            type="button"
            variant="ghost"
            size="xs"
            onClick={addArgument}
          >
            <Plus className="size-3" />
            {translate(
              'auto.components.settings.CustomAgentProfileEditor.addArgument',
              'Add argument'
            )}
          </Button>
        </div>
        {profile.args.map((arg, index) => (
          <div key={argumentIdsRef.current[index]} className="flex items-center gap-1.5">
            <Input
              ref={(node) => {
                argumentInputRefs.current[index] = node
              }}
              value={arg}
              aria-label={translate(
                'auto.components.settings.CustomAgentProfileEditor.argumentNumber',
                'Argument {{value0}}',
                { value0: String(index + 1) }
              )}
              onChange={(event) =>
                setArgs(
                  profile.args.map((value, argIndex) =>
                    argIndex === index ? event.target.value : value
                  )
                )
              }
            />
            <AgentRowAction
              label={translate(
                'auto.components.settings.CustomAgentProfileEditor.removeArgument',
                'Remove argument {{value0}}',
                { value0: String(index + 1) }
              )}
              onClick={() => removeArgument(index)}
            >
              <X className="size-3.5" />
            </AgentRowAction>
          </div>
        ))}
      </div>

      {errors.profile && !errors.executable ? (
        <p className="text-xs text-destructive" role="alert">
          {errors.profile}
        </p>
      ) : null}
      {persistenceError ? (
        <p className="text-xs text-destructive" role="alert">
          {persistenceError}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          {translate('auto.components.settings.CustomAgentProfileEditor.cancel', 'Cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={saving || Object.keys(errors).length > 0}>
          {saving
            ? translate('auto.components.settings.CustomAgentProfileEditor.saving', 'Saving…')
            : translate('auto.components.settings.CustomAgentProfileEditor.save', 'Save')}
        </Button>
      </div>
    </form>
  )
}
