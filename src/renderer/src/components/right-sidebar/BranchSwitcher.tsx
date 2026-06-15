import { useState } from 'react'
import { Check, ChevronDown, GitBranch, Plus, ArrowRight } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { Worktree } from '../../../../shared/types'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client'
import type { BranchSwitchCandidate } from './branch-switch-candidates'
import { useBranchSwitch } from './useBranchSwitch'

export function BranchSwitcherList({
  query,
  setQuery,
  loading,
  candidates,
  onSelect,
  onCreate,
  disabled = false
}: {
  query: string
  setQuery: (value: string) => void
  loading: boolean
  candidates: BranchSwitchCandidate[]
  onSelect: (candidate: BranchSwitchCandidate) => void
  onCreate: (name: string) => void
  disabled?: boolean
}): React.JSX.Element {
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const locals = candidates.filter((c) => c.kind === 'local')
  const remotes = candidates.filter((c) => c.kind === 'remote')

  return (
    <div className="flex w-full flex-col">
      <div className="border-b border-border p-2">
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={translate('auto.branchSwitch.search', 'Search branches…')}
          className="h-8"
        />
      </div>
      {/* Why: the cap must sit on the radix viewport (the scrolling element), not
          the root — on the root the list overflows and paints over the footer. */}
      <ScrollArea viewportClassName="max-h-72">
        <div className="p-1">
          {loading && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              {translate('auto.branchSwitch.searching', 'Searching…')}
            </div>
          )}
          {!loading && candidates.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              {translate('auto.branchSwitch.none', 'No matching branches.')}
            </div>
          )}
          {locals.length > 0 && (
            <Section label={translate('auto.branchSwitch.local', 'Local')}>
              {locals.map((c) => (
                <BranchRow
                  key={`local:${c.branchName}`}
                  candidate={c}
                  onSelect={onSelect}
                  disabled={disabled}
                />
              ))}
            </Section>
          )}
          {remotes.length > 0 && (
            <Section label={translate('auto.branchSwitch.remote', 'Remote')}>
              {remotes.map((c) => (
                <BranchRow
                  key={`remote:${c.refName}`}
                  candidate={c}
                  onSelect={onSelect}
                  disabled={disabled}
                />
              ))}
            </Section>
          )}
        </div>
      </ScrollArea>
      <div className="border-t border-border p-1">
        {creating ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              onCreate(newName)
              setCreating(false)
              setNewName('')
            }}
            className="flex gap-1 p-1"
          >
            <Input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={translate('auto.branchSwitch.newName', 'New branch name')}
              className="h-8"
              disabled={disabled}
            />
            <Button type="submit" size="sm" className="h-8" disabled={disabled}>
              {translate('auto.branchSwitch.create', 'Create')}
            </Button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setCreating(true)}
            disabled={disabled}
            className={cn(
              'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent',
              disabled && 'pointer-events-none opacity-50'
            )}
          >
            <Plus className="size-3.5 shrink-0" aria-hidden="true" />
            {translate('auto.branchSwitch.createNew', 'Create new branch…')}
          </button>
        )}
      </div>
    </div>
  )
}

function Section({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="py-1">
      <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  )
}

function BranchRow({
  candidate,
  onSelect,
  disabled = false
}: {
  candidate: BranchSwitchCandidate
  onSelect: (candidate: BranchSwitchCandidate) => void
  disabled?: boolean
}): React.JSX.Element {
  // Why: git refuses to check out a branch held by another worktree, so a row
  // for one is rendered muted and the click jumps to that workspace instead.
  const disabledElsewhere = candidate.checkedOutInWorktreeId !== null
  return (
    <button
      type="button"
      onClick={() => onSelect(candidate)}
      disabled={disabled}
      className={cn(
        'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent',
        candidate.isCurrent && 'font-medium',
        disabledElsewhere && 'text-muted-foreground',
        disabled && 'pointer-events-none opacity-50'
      )}
    >
      {candidate.isCurrent ? (
        <Check className="size-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <GitBranch className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
      )}
      <span className="truncate">{candidate.refName}</span>
      {disabledElsewhere && candidate.checkedOutInWorktreeName && (
        <span className="ml-auto flex items-center gap-1 text-[11px]">
          {translate('auto.branchSwitch.inWorkspace', 'in {{value0}}', {
            value0: candidate.checkedOutInWorktreeName
          })}
          <ArrowRight className="size-3 shrink-0" aria-hidden="true" />
        </span>
      )}
      {candidate.isCurrent && (
        <span className="ml-auto text-[11px] text-muted-foreground">
          {translate('auto.branchSwitch.current', 'current')}
        </span>
      )}
    </button>
  )
}

export function BranchSwitcher(props: {
  repoId: string | null
  worktrees: Worktree[]
  activeWorktreeId: string | null
  activeBranchName: string
  detachedLabel: string | null
  gitContext: RuntimeGitContext
  onSwitched: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const { query, setQuery, loading, candidates, isSwitching, switchToCandidate, createBranch } =
    useBranchSwitch({
      repoId: props.repoId,
      worktrees: props.worktrees,
      activeWorktreeId: props.activeWorktreeId,
      activeBranchName: props.activeBranchName,
      gitContext: props.gitContext,
      onSwitched: () => {
        setOpen(false)
        props.onSwitched()
      }
    })

  // Why: detached HEAD label wins; otherwise show the branch, falling back to a
  // placeholder. Parens are required since `??` and `||` can't be mixed bare.
  const label =
    props.detachedLabel ??
    (props.activeBranchName || translate('auto.branchSwitch.noBranch', 'No branch'))

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs hover:bg-accent"
        >
          <GitBranch className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
          <span className="truncate font-medium">{label}</span>
          <ChevronDown className="ml-auto size-3.5 shrink-0 opacity-60" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
        <BranchSwitcherList
          query={query}
          setQuery={setQuery}
          loading={loading}
          candidates={candidates}
          onSelect={(c) => void switchToCandidate(c)}
          onCreate={(name) => void createBranch(name)}
          disabled={isSwitching}
        />
      </PopoverContent>
    </Popover>
  )
}
