import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Plus, Terminal, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import {
  CUSTOM_AGENT_PROFILES_MAX,
  isCustomAgentProfileEnabled,
  normalizeCustomAgentProfile,
  setDefaultCustomAgentProfile,
  type CustomAgentProfile
} from '../../../../shared/custom-agent-profile'
import { Button } from '../ui/button'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { SettingsBadge, SettingsSubsectionHeader } from './SettingsFormControls'
import { AgentRowAction, AgentSettingsRow } from './AgentSettingsRow'
import {
  createCustomAgentProfileDraft,
  type CustomAgentProfileDraft
} from './custom-agent-profile-draft'
import {
  CustomAgentProfileEditor,
  validateCustomAgentDraft,
  type CustomAgentEditorState
} from './CustomAgentProfileEditor'

export type CustomAgentProfilesSectionHandle = {
  openProfile: (profile: CustomAgentProfileDraft) => void
}

function profileSummary(profile: CustomAgentProfile): string {
  return [profile.executable, ...profile.args.map((arg) => JSON.stringify(arg))].join(' ')
}

type CustomAgentProfilesSectionProps = {
  profiles: readonly CustomAgentProfile[]
  catalog: readonly AgentCatalogEntry[]
  onProfilesChange: (profiles: CustomAgentProfile[]) => void | Promise<void>
}

export const CustomAgentProfilesSection = forwardRef<
  CustomAgentProfilesSectionHandle,
  CustomAgentProfilesSectionProps
>(function CustomAgentProfilesSection(
  { profiles, catalog, onProfilesChange },
  ref
): React.JSX.Element {
  const [editor, setEditor] = useState<CustomAgentEditorState | null>(null)
  const [saving, setSaving] = useState(false)
  const [persistenceError, setPersistenceError] = useState<string | null>(null)
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const createButtonRef = useRef<HTMLButtonElement | null>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const mutationInFlightRef = useRef(false)
  const editorProfileId = editor?.profile.id

  const openEditor = useCallback(
    (next: CustomAgentEditorState): void => {
      if (editor || saving) {
        setPersistenceError(
          translate(
            'auto.components.settings.CustomAgentProfilesSection.finishEditing',
            'Finish editing the current custom agent before opening another.'
          )
        )
        return
      }
      returnFocusRef.current = document.activeElement as HTMLElement | null
      setPersistenceError(null)
      setEditor(next)
    },
    [editor, saving]
  )

  useImperativeHandle(
    ref,
    () => ({
      openProfile: (profile) => openEditor({ originalId: null, profile })
    }),
    [openEditor]
  )

  useEffect(() => {
    if (!editorProfileId) {
      return
    }
    const frame = requestAnimationFrame(() => nameInputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [editorProfileId])

  const closeEditor = (): void => {
    setEditor(null)
    setPersistenceError(null)
    requestAnimationFrame(() => returnFocusRef.current?.focus())
  }
  const persistProfiles = async (next: CustomAgentProfile[]): Promise<boolean> => {
    if (mutationInFlightRef.current) {
      return false
    }
    mutationInFlightRef.current = true
    setSaving(true)
    setPersistenceError(null)
    try {
      await onProfilesChange(next)
      return true
    } catch (error) {
      setPersistenceError(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      mutationInFlightRef.current = false
      setSaving(false)
    }
  }
  const save = async (): Promise<void> => {
    if (!editor) {
      return
    }
    const errors = validateCustomAgentDraft(editor.profile, profiles, catalog, editor.originalId)
    if (Object.keys(errors).length > 0) {
      return
    }
    if (!editor.originalId && profiles.length >= CUSTOM_AGENT_PROFILES_MAX) {
      toast.error(
        translate(
          'auto.components.settings.CustomAgentProfilesSection.limit',
          'Custom agents are limited to {{value0}} profiles.',
          { value0: String(CUSTOM_AGENT_PROFILES_MAX) }
        )
      )
      return
    }
    const normalized = normalizeCustomAgentProfile(editor.profile)!
    const next = editor.originalId
      ? profiles.map((profile) => (profile.id === editor.originalId ? normalized : profile))
      : [...profiles, normalized]
    if (await persistProfiles(next)) {
      closeEditor()
    }
  }
  const setEnabled = (profile: CustomAgentProfile, enabled: boolean): void => {
    const next = profiles.map((candidate) => {
      if (candidate.id !== profile.id) {
        return candidate
      }
      const { enabled: _enabled, isDefault: _isDefault, ...rest } = candidate
      return enabled ? rest : { ...rest, enabled: false }
    })
    void persistProfiles(next)
  }

  const editorElement = editor ? (
    <CustomAgentProfileEditor
      editor={editor}
      catalog={catalog}
      profiles={profiles}
      saving={saving}
      persistenceError={persistenceError}
      nameInputRef={nameInputRef}
      onChange={(profile) => {
        setPersistenceError(null)
        setEditor((current) => (current ? { ...current, profile } : null))
      }}
      onSave={() => void save()}
      onCancel={closeEditor}
    />
  ) : null

  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={
          <span className="flex items-center gap-2">
            {translate(
              'auto.components.settings.CustomAgentProfilesSection.title',
              'Custom agents'
            )}
            {profiles.length > 0 ? (
              <SettingsBadge tone="accent">{profiles.length}</SettingsBadge>
            ) : null}
          </span>
        }
        action={
          <Button
            ref={createButtonRef}
            type="button"
            variant="outline"
            size="xs"
            disabled={Boolean(editor) || saving || profiles.length >= CUSTOM_AGENT_PROFILES_MAX}
            onClick={() =>
              openEditor({ originalId: null, profile: createCustomAgentProfileDraft() })
            }
          >
            <Plus className="size-3" />
            {translate(
              'auto.components.settings.CustomAgentProfilesSection.create',
              'Create custom agent'
            )}
          </Button>
        }
      />

      {profiles.length === 0 && !editor ? (
        <div className="rounded-md border border-dashed border-border/50 px-3 py-4 text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.CustomAgentProfilesSection.empty',
            'No custom agents yet. Create one or duplicate an installed agent above.'
          )}
        </div>
      ) : null}

      {profiles.length > 0 ? (
        <div className="divide-y divide-border/40">
          {profiles.map((profile) => {
            const isEditing = editor?.originalId === profile.id
            return (
              <AgentSettingsRow
                key={profile.id}
                label={profile.name}
                icon={
                  profile.baseAgent ? (
                    <AgentIcon agent={profile.baseAgent} size={16} />
                  ) : (
                    <Terminal className="size-4 text-muted-foreground" />
                  )
                }
                summary={profileSummary(profile)}
                isEnabled={isCustomAgentProfileEnabled(profile)}
                isDefault={profile.isDefault === true}
                onSetEnabled={(enabled) => setEnabled(profile, enabled)}
                onSetDefault={() =>
                  void persistProfiles(setDefaultCustomAgentProfile(profiles, profile.id))
                }
                secondAction={
                  <DeleteProfileAction
                    profile={profile}
                    disabled={Boolean(editor) || saving}
                    onDelete={() =>
                      persistProfiles(profiles.filter((candidate) => candidate.id !== profile.id))
                    }
                    onDeleted={() => requestAnimationFrame(() => createButtonRef.current?.focus())}
                  />
                }
                detailsOpen={isEditing}
                toggleDetailsLabel={
                  isEditing
                    ? translate(
                        'auto.components.settings.CustomAgentProfilesSection.closeEditor',
                        'Close {{value0}} editor',
                        { value0: profile.name }
                      )
                    : translate(
                        'auto.components.settings.CustomAgentProfilesSection.editProfile',
                        'Edit {{value0}}',
                        { value0: profile.name }
                      )
                }
                onToggleDetails={() =>
                  isEditing
                    ? closeEditor()
                    : openEditor({
                        originalId: profile.id,
                        profile: { ...profile, args: [...profile.args] }
                      })
                }
              >
                {isEditing ? editorElement : null}
              </AgentSettingsRow>
            )
          })}
        </div>
      ) : null}

      {editor?.originalId === null ? editorElement : null}
      {persistenceError && !editor ? (
        <p className="text-xs text-destructive" role="alert">
          {persistenceError}
        </p>
      ) : null}
    </section>
  )
})

function DeleteProfileAction({
  profile,
  disabled,
  onDelete,
  onDeleted
}: {
  profile: CustomAgentProfile
  disabled: boolean
  onDelete: () => Promise<boolean>
  onDeleted: () => void
}): React.JSX.Element {
  const confirm = useConfirmationDialog()
  const label = translate(
    'auto.components.settings.CustomAgentProfilesSection.deleteNamed',
    'Delete {{value0}}',
    { value0: profile.name }
  )
  const handleDelete = async (): Promise<void> => {
    const accepted = await confirm({
      title: translate(
        'auto.components.settings.CustomAgentProfilesSection.deleteTitle',
        'Delete {{value0}}?',
        { value0: profile.name }
      ),
      description: translate(
        'auto.components.settings.CustomAgentProfilesSection.deleteDescription',
        'Existing terminals keep their captured launch command. This removes the profile from future launches.'
      ),
      confirmLabel: translate(
        'auto.components.settings.CustomAgentProfilesSection.delete',
        'Delete'
      ),
      confirmVariant: 'destructive'
    })
    if (accepted && (await onDelete())) {
      onDeleted()
    }
  }
  return (
    <AgentRowAction label={label} disabled={disabled} onClick={() => void handleDelete()}>
      <Trash2 className="size-3.5" />
    </AgentRowAction>
  )
}
