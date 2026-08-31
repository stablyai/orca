import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Pencil, Plus, Terminal, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import {
  CUSTOM_AGENT_PROFILES_MAX,
  normalizeCustomAgentProfile,
  normalizeCustomAgentProfiles,
  type CustomAgentProfile
} from '../../../../shared/custom-agent-profile'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { SettingsSubsectionHeader } from './SettingsFormControls'
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
    setSaving(true)
    try {
      await onProfilesChange(normalizeCustomAgentProfiles(next))
      closeEditor()
    } catch (error) {
      setPersistenceError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={translate(
          'auto.components.settings.CustomAgentProfilesSection.title',
          'Custom agents'
        )}
        description={translate(
          'auto.components.settings.CustomAgentProfilesSection.description',
          'Create independent launch profiles with a command and literal arguments.'
        )}
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
            'No custom agents yet. Create one from scratch or duplicate a built-in agent below.'
          )}
        </div>
      ) : null}

      {profiles.length > 0 ? (
        <div className="divide-y divide-border/40">
          {profiles.map((profile) => (
            <div key={profile.id} className="flex items-center gap-3 py-3">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/50 bg-background/50">
                <Terminal className="size-4 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium leading-none">{profile.name}</span>
                <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                  {profileSummary(profile)}
                </div>
              </div>
              <ProfileAction
                label={translate(
                  'auto.components.settings.CustomAgentProfilesSection.edit',
                  'Edit {{value0}}',
                  { value0: profile.name }
                )}
                disabled={Boolean(editor) || saving}
                onClick={() =>
                  openEditor({
                    originalId: profile.id,
                    profile: { ...profile, args: [...profile.args] }
                  })
                }
              >
                <Pencil className="size-3.5" />
              </ProfileAction>
              <DeleteProfileAction
                profile={profile}
                disabled={Boolean(editor) || saving}
                onBegin={() => {
                  if (mutationInFlightRef.current) {
                    return false
                  }
                  mutationInFlightRef.current = true
                  setSaving(true)
                  setPersistenceError(null)
                  return true
                }}
                onDelete={() =>
                  onProfilesChange(profiles.filter((candidate) => candidate.id !== profile.id))
                }
                onDeleted={() => requestAnimationFrame(() => createButtonRef.current?.focus())}
                onError={setPersistenceError}
                onFinish={() => {
                  mutationInFlightRef.current = false
                  setSaving(false)
                }}
              />
            </div>
          ))}
        </div>
      ) : null}

      {editor ? (
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
      ) : null}
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
  onBegin,
  onDelete,
  onDeleted,
  onError,
  onFinish
}: {
  profile: CustomAgentProfile
  disabled: boolean
  onBegin: () => boolean
  onDelete: () => void | Promise<void>
  onDeleted: () => void
  onError: (message: string) => void
  onFinish: () => void
}): React.JSX.Element {
  const confirm = useConfirmationDialog()
  const label = translate(
    'auto.components.settings.CustomAgentProfilesSection.deleteNamed',
    'Delete {{value0}}',
    { value0: profile.name }
  )
  const handleDelete = async (): Promise<void> => {
    if (!onBegin()) {
      return
    }
    try {
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
      if (!accepted) {
        return
      }
      await onDelete()
      onDeleted()
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      onFinish()
    }
  }
  return (
    <ProfileAction label={label} disabled={disabled} onClick={() => void handleDelete()}>
      <Trash2 className="size-3.5" />
    </ProfileAction>
  )
}
export function ProfileAction({
  label,
  disabled = false,
  onClick,
  children
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          onClick={onClick}
          aria-label={label}
          className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
