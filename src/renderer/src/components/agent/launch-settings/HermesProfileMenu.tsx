import { Check, ChevronDown } from 'lucide-react'
import { Button } from '../../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../../ui/dropdown-menu'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import {
  readHermesProfileArg,
  withHermesProfileArgs
} from '../../../../../shared/agent-launch/startup/hermes-profile'
import type { AgentPickerEdit } from '../../../../../shared/agent-launch/picker/agent-launch-picker-edits'
import type {
  AgentPickerDraft,
  AgentPickerEntry,
  AgentPickerSurface
} from '../../../../../shared/agent-launch/picker/agent-launch-picker'
import { useHermesLaunchProfiles } from '../launch-menu/use-hermes-launch-profiles'

/** A picked profile rides the pane's Arguments, which only a terminal launch reads; a chat would
 *  silently run the host's default profile, so the card refuses that surface instead. */
export function hermesProfileSurfaceUnavailable(
  entry: AgentPickerEntry,
  draft: AgentPickerDraft,
  t: Translate
): Partial<Record<AgentPickerSurface, string>> | undefined {
  if (entry.agent !== 'hermes') {
    return undefined
  }
  const argsText = draft.pendingArguments ?? draft.arguments ?? ''
  return readHermesProfileArg(argsText) === null
    ? undefined
    : {
        chat: t(
          'agentPicker.hermesProfileTerminalOnly',
          'A Hermes profile launch runs in the terminal'
        )
      }
}

/** Hermes' named profiles in the picker card: picking one folds `--profile <id>` into the pane's
 *  Arguments, so a picked profile reaches the same launch path as typed text. */
export function HermesProfileMenu({
  entry,
  draft,
  disabled,
  installed,
  searching,
  onEdit
}: {
  entry: AgentPickerEntry
  draft: AgentPickerDraft
  disabled?: boolean
  /** The card's own gates: an uninstalled agent has no launch to configure, and a search previews models. */
  installed: boolean
  searching: boolean
  onEdit: (edit: AgentPickerEdit) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  // The card knows the surface it launches: a chat has no command line to carry the flag.
  const terminal = entry.surfaces.includes('terminal')
  // The rows already resolved this workspace's host (`cli`, `terminal`, or a chat variant);
  // the draft target covers pickers built without rows.
  const executionHostId =
    entry.rows.find((row) => 'executionHostId' in row)?.executionHostId ??
    entry.draftTarget?.executionHostId
  const profiles = useHermesLaunchProfiles(
    entry.agent === 'hermes' && terminal,
    executionHostId,
    entry.worktreeId ?? entry.draftTarget?.worktreeId
  )
  // An absent or empty list leaves the card as it was: no named profiles, nothing to pick.
  if (
    entry.agent !== 'hermes' ||
    !terminal ||
    !installed ||
    searching ||
    !profiles ||
    profiles.profiles.length === 0
  ) {
    return null
  }
  const argsText = draft.pendingArguments ?? draft.arguments ?? entry.arguments ?? ''
  const picked = readHermesProfileArg(argsText)
  const label = picked ?? t('agentPicker.hermesDefaultProfile', 'Default')
  const choose = (profile: string | null) =>
    onEdit({ kind: 'arguments', text: withHermesProfileArgs(argsText, profile) })
  return (
    <div className="flex min-h-7 min-w-0 shrink-0 items-center justify-between gap-3 border-t border-border px-2.5 py-1.5">
      <span className="text-xs text-muted-foreground">
        {t('agentPicker.hermesProfile', 'Profile')}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <Button
            type="button"
            variant="outline"
            size="xs"
            aria-label={t('agentPicker.hermesProfileLabel', '{{agent}} profile', {
              agent: entry.label
            })}
            className="min-w-0 max-w-full"
          >
            <span className="min-w-0 truncate text-xs">{label}</span>
            <ChevronDown className="size-3 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" collisionPadding={8} className="min-w-0">
          <DropdownMenuItem
            onSelect={() => {
              choose(null)
            }}
          >
            {t('agentPicker.hermesDefaultProfile', 'Default')}
            {picked === null ? <Check className="ml-auto size-4" /> : null}
          </DropdownMenuItem>
          {profiles.profiles.map((profile) => (
            <DropdownMenuItem
              key={profile}
              onSelect={() => {
                choose(profile)
              }}
            >
              {profile}
              {picked === profile ? <Check className="ml-auto size-4" /> : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
