import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { translate } from '@/i18n/i18n'
import type {
  LineageAddManualLinkArgs,
  LineageManualLinkTarget
} from '../../../../../shared/fleet-lineage-types'
import type { LineageManualLinkKind } from '../../../../../shared/lineage-discovery-types'
import { AddToTowerWorktreePicker, type PickedWorktree } from './AddToTowerWorktreePicker'
import { AddToTowerBranchPicker, type PickedBranch } from './AddToTowerBranchPicker'

const KINDS: readonly LineageManualLinkKind[] = ['worktree', 'branch', 'pr']

function isKind(value: string): value is LineageManualLinkKind {
  return KINDS.some((kind) => kind === value)
}

function kindLabel(kind: LineageManualLinkKind): string {
  switch (kind) {
    case 'worktree':
      return translate(
        'auto.components.rightSidebar.lineageMembers.addToTower.worktree',
        'Worktree'
      )
    case 'branch':
      return translate('auto.components.rightSidebar.lineageMembers.addToTower.branch', 'Branch')
    case 'pr':
      return translate(
        'auto.components.rightSidebar.lineageMembers.addToTower.pullRequest',
        'Pull request'
      )
  }
}

function addArgs(
  parentWorkspaceKey: string,
  target: LineageManualLinkTarget
): LineageAddManualLinkArgs {
  // why: a host from before targets still understands the bare reference of a pull request
  return target.kind === 'pr'
    ? { parentWorkspaceKey, reference: target.reference, target }
    : { parentWorkspaceKey, target }
}

type AddToTowerFormProps = {
  parentWorkspaceKey: string
  /** Called after a successful add so the host surface can close. */
  onAdded: () => void
  onChanged: () => void
}

export function AddToTowerForm({
  parentWorkspaceKey,
  onAdded,
  onChanged
}: AddToTowerFormProps): React.JSX.Element {
  const [kind, setKind] = useState<LineageManualLinkKind>('worktree')
  const [worktree, setWorktree] = useState<PickedWorktree | null>(null)
  const [branch, setBranch] = useState<PickedBranch | null>(null)
  const [reference, setReference] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const target: LineageManualLinkTarget | null =
    kind === 'worktree'
      ? worktree && { kind: 'worktree', ...worktree }
      : kind === 'branch'
        ? branch && { kind: 'branch', ...branch }
        : reference.trim()
          ? { kind: 'pr', reference: reference.trim() }
          : null

  const submit = async (): Promise<void> => {
    if (!target || submitting) {
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const result = await window.api.git.lineageAddManualLink(addArgs(parentWorkspaceKey, target))
      if (result.success) {
        onAdded()
        onChanged()
      } else {
        setError(
          result.error ??
            translate(
              'auto.components.rightSidebar.lineageMembers.addToTower.failed',
              'Could not add to the control tower'
            )
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={kind}
        onValueChange={(next) => {
          if (isKind(next)) {
            setKind(next)
            setError(null)
          }
        }}
      >
        {KINDS.map((option) => (
          <ToggleGroupItem key={option} value={option}>
            {kindLabel(option)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {kind === 'worktree' ? (
        <AddToTowerWorktreePicker value={worktree} onChange={setWorktree} />
      ) : kind === 'branch' ? (
        <AddToTowerBranchPicker value={branch} onChange={setBranch} />
      ) : (
        <Input
          autoFocus
          value={reference}
          onChange={(event) => setReference(event.target.value)}
          placeholder={translate(
            'auto.components.rightSidebar.lineageMembers.addPullRequestPlaceholder',
            'https://github.com/org/repo/pull/12 or repo#12'
          )}
          aria-invalid={error !== null}
        />
      )}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={submitting || target === null}>
          {translate('auto.components.rightSidebar.lineageMembers.addPullRequestSubmit', 'Add')}
        </Button>
      </div>
    </form>
  )
}
