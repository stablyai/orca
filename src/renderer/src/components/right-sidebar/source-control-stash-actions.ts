import { translate } from '@/i18n/i18n'
import type { DropdownActionKind } from './source-control-dropdown-items'
import type { GitStashEntry, GitStashMutationResult } from '../../../../shared/git-stash-types'

export type StashPickerMode = 'stash_pop_pick' | 'stash_apply_pick' | 'stash_drop_pick'

const PICKER_MODES: DropdownActionKind[] = ['stash_pop_pick', 'stash_apply_pick', 'stash_drop_pick']

export function isStashPickerAction(kind: DropdownActionKind): kind is StashPickerMode {
  return PICKER_MODES.includes(kind)
}

export function isStashAction(kind: DropdownActionKind): boolean {
  return kind.startsWith('stash')
}

/** Copy for the picker dialog, per action. */
export function stashPickerCopy(mode: StashPickerMode): { title: string; description: string } {
  if (mode === 'stash_apply_pick') {
    return {
      title: translate(
        'auto.components.right.sidebar.source.control.stash.actions.applyTitle',
        'Apply stash'
      ),
      description: translate(
        'auto.components.right.sidebar.source.control.stash.actions.applyDescription',
        'Pick a stash to apply. It stays in the list.'
      )
    }
  }
  if (mode === 'stash_drop_pick') {
    return {
      title: translate(
        'auto.components.right.sidebar.source.control.stash.actions.dropTitle',
        'Drop stash'
      ),
      description: translate(
        'auto.components.right.sidebar.source.control.stash.actions.dropDescription',
        'Pick a stash to delete permanently. This cannot be undone.'
      )
    }
  }
  return {
    title: translate(
      'auto.components.right.sidebar.source.control.stash.actions.popTitle',
      'Pop stash'
    ),
    description: translate(
      'auto.components.right.sidebar.source.control.stash.actions.popDescription',
      'Pick a stash to apply and remove from the list.'
    )
  }
}

export function dropStashConfirmation(entry: GitStashEntry): {
  title: string
  description: string
  confirmLabel: string
} {
  return {
    title: translate(
      'auto.components.right.sidebar.source.control.stash.actions.dropConfirmTitle',
      'Drop this stash?'
    ),
    description: translate(
      'auto.components.right.sidebar.source.control.stash.actions.dropConfirmDescription',
      '{{value0}} will be deleted permanently. This cannot be undone.',
      { value0: describeStashEntry(entry) }
    ),
    confirmLabel: translate(
      'auto.components.right.sidebar.source.control.stash.actions.dropConfirmLabel',
      'Drop stash'
    )
  }
}

export function dropAllStashesConfirmation(count: number): {
  title: string
  description: string
  confirmLabel: string
} {
  return {
    title: translate(
      'auto.components.right.sidebar.source.control.stash.actions.dropAllConfirmTitle',
      'Drop all stashes?'
    ),
    description:
      count === 1
        ? translate(
            'auto.components.right.sidebar.source.control.stash.actions.dropAllConfirmOne',
            '1 stash will be deleted permanently. This cannot be undone.'
          )
        : translate(
            'auto.components.right.sidebar.source.control.stash.actions.dropAllConfirmMany',
            '{{value0}} stashes will be deleted permanently. This cannot be undone.',
            { value0: count }
          ),
    confirmLabel: translate(
      'auto.components.right.sidebar.source.control.stash.actions.dropAllConfirmLabel',
      'Drop all'
    )
  }
}

export function describeStashEntry(entry: GitStashEntry): string {
  return entry.subject.trim().length > 0 ? entry.subject : entry.ref
}

/**
 * Message for a failed apply/pop.
 *
 * A conflict is not a failure to retry: git kept the entry and left the merge in
 * the working tree, so the copy has to say both, and name the ref — the commit
 * area (and with it the Stash menu) unmounts while conflicts are unresolved, so
 * this text is the user's only pointer back to the surviving stash.
 */
export function stashRestoreErrorMessage(
  result: GitStashMutationResult,
  ref: string | null
): string {
  if (!result.conflicted) {
    return (
      result.error ??
      translate(
        'auto.components.right.sidebar.source.control.stash.actions.restoreFailed',
        'Stash could not be restored.'
      )
    )
  }
  return ref
    ? translate(
        'auto.components.right.sidebar.source.control.stash.actions.conflictNamed',
        'Stash applied with conflicts. Resolve them, then drop {{value0}} manually — it was kept.',
        { value0: ref }
      )
    : translate(
        'auto.components.right.sidebar.source.control.stash.actions.conflict',
        'Stash applied with conflicts. Resolve them, then drop the stash manually — it was kept.'
      )
}

export type StashMessagePromptMode = 'stash' | 'stash_include_untracked'

export function isStashMessagePromptAction(
  kind: DropdownActionKind
): kind is StashMessagePromptMode {
  return kind === 'stash' || kind === 'stash_include_untracked'
}

/** Copy for the "name this stash" prompt, per variant. */
export function stashMessagePromptCopy(mode: StashMessagePromptMode): {
  title: string
  description: string
  confirmLabel: string
} {
  return {
    title:
      mode === 'stash_include_untracked'
        ? translate(
            'auto.components.right.sidebar.source.control.stash.actions.pushUntrackedTitle',
            'Stash tracked and untracked changes'
          )
        : translate(
            'auto.components.right.sidebar.source.control.stash.actions.pushTitle',
            'Stash tracked changes'
          ),
    description: translate(
      'auto.components.right.sidebar.source.control.stash.actions.pushDescription',
      'Optionally name this stash. Leave it empty to use Git’s default message.'
    ),
    confirmLabel: translate(
      'auto.components.right.sidebar.source.control.stash.actions.pushConfirmLabel',
      'Stash'
    )
  }
}

/**
 * Message for a failed stash push.
 *
 * Git refuses to stash before the first commit; the raw wording is cryptic in a
 * source-control panel, so name the actual next step.
 */
export function stashPushErrorMessage(error: string | undefined): string {
  if (error && /you do not have the initial commit yet/i.test(error)) {
    return translate(
      'auto.components.right.sidebar.source.control.stash.actions.noInitialCommit',
      'This repository has no commits yet. Make an initial commit before stashing.'
    )
  }
  return (
    error ??
    translate(
      'auto.components.right.sidebar.source.control.stash.actions.pushFailed',
      'Could not stash changes.'
    )
  )
}

/** Message for a push that git accepted but which created no entry. */
export function stashPushOutcomeMessage(stashed: boolean): string | null {
  return stashed
    ? null
    : translate(
        'auto.components.right.sidebar.source.control.stash.actions.nothingStashed',
        'Nothing to stash — the working tree is already clean.'
      )
}

/** A concurrent stash moved the picked entry; the caller must refetch and re-prompt. */
export function isStashEntryMovedError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('stash_entry_moved')
}

export function stashEntryMovedMessage(): string {
  return translate(
    'auto.components.right.sidebar.source.control.stash.actions.entryMoved',
    'The stash list changed since it was opened. Reopen the menu and try again.'
  )
}
