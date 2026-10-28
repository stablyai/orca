// UX mockups for docs/multi-repo-workspaces-ux.md. Static markup built from real primitives and
// tokens; not wired to the store. Replace with fixtures of the real components when they exist.
import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { cn } from '@/lib/utils'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { ComposerShell, RepoDot, REPOS } from './multi-repo-ux-fixture-parts'

function ProjectChips({ withLast }: { withLast?: boolean }): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        Projects
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {REPOS.map((repo) => (
          <span
            key={repo.name}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background pl-2 pr-1 text-sm"
          >
            <RepoDot color={repo.color} />
            {repo.name}
            <Button variant="ghost" size="icon-xs" aria-label={`Remove ${repo.name}`}>
              <X />
            </Button>
          </span>
        ))}
        <Button variant="outline" size="sm" className="h-7">
          <Plus /> Add project
        </Button>
      </div>
      {withLast ? (
        <div className="text-xs text-muted-foreground">
          Same as last time: <span className="text-foreground">api, web, infra</span>
        </div>
      ) : null}
    </div>
  )
}

function CreateBody({ advanced }: { advanced: boolean }): React.JSX.Element {
  return (
    <ComposerShell>
      <div className="mb-4 text-base font-semibold">New workspace</div>
      <div className="space-y-4">
        <ProjectChips withLast />
        <div className="space-y-1.5">
          <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            Name
          </div>
          <Input defaultValue="checkout-flow" aria-label="Workspace name" />
          <div className="text-xs text-muted-foreground">
            Branch <span className="font-mono">checkout-flow</span> in all 3 projects
          </div>
        </div>
        <button
          type="button"
          className="flex items-center gap-1 text-xs font-medium text-muted-foreground"
          aria-expanded={advanced}
        >
          {advanced ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          Advanced
        </button>
        {advanced ? (
          <div className="overflow-hidden rounded-md border border-border text-sm">
            <div className="grid grid-cols-[88px_1fr_1fr] gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              <span>Project</span>
              <span>Branch</span>
              <span>Start from</span>
            </div>
            {[
              { n: 'api', c: '#4f8cff', b: 'checkout-flow', s: 'origin/main', err: null },
              {
                n: 'web',
                c: '#e0a030',
                b: 'checkout-flow-web',
                s: 'origin/develop',
                err: null
              },
              {
                n: 'infra',
                c: '#4fb286',
                b: 'checkout-flow',
                s: 'origin/main',
                err: 'Branch already exists in infra'
              }
            ].map((row) => (
              <div
                key={row.n}
                className="grid grid-cols-[88px_1fr_1fr] items-start gap-2 border-b border-border px-3 py-2 last:border-b-0"
              >
                <span className="flex h-8 items-center gap-1.5">
                  <RepoDot color={row.c} />
                  {row.n}
                </span>
                <div className="space-y-1">
                  <Input
                    defaultValue={row.b}
                    aria-invalid={row.err ? true : undefined}
                    aria-label={`Branch in ${row.n}`}
                  />
                  {row.err ? <div className="text-xs text-destructive">{row.err}</div> : null}
                </div>
                <Button variant="outline" size="sm" className="justify-between">
                  {row.s}
                  <ChevronDown />
                </Button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <div className="mt-5 flex items-center justify-end gap-2">
        <Button variant="ghost">Cancel</Button>
        <Button disabled={advanced}>
          Create in 3 projects
          <ShortcutKeyCombo keys={['⌘', '↵']} keyCapClassName="" />
        </Button>
      </div>
    </ComposerShell>
  )
}

export const createDialog = defineFixture({
  width: 520,
  render: () => <CreateBody advanced={false} />
})

export const createDialogAdvancedWithConflict = defineFixture({
  width: 560,
  render: () => <CreateBody advanced />
})

export const createDialogDisabledProjects = defineFixture({
  width: 380,
  render: () => (
    <div className="w-full rounded-md border border-border bg-popover p-1 text-sm shadow-floating">
      <div className="px-2 py-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        Add project
      </div>
      {[
        { n: 'web', note: null, on: true, checked: true },
        { n: 'infra', note: null, on: true, checked: false },
        {
          n: 'billing-svc',
          note: 'On ssh: build-box. A workspace folder cannot span hosts.',
          on: false,
          checked: false
        },
        { n: 'notes', note: 'Folder project, no git worktrees.', on: false, checked: false }
      ].map((row) => (
        <div
          key={row.n}
          aria-disabled={!row.on}
          className={cn(
            'flex items-start gap-2 rounded-sm px-2 py-1.5',
            row.on ? 'hover:bg-accent' : 'opacity-60'
          )}
        >
          <Checkbox checked={row.checked} disabled={!row.on} className="mt-0.5" />
          <div className="min-w-0">
            <div>{row.n}</div>
            {row.note ? <div className="text-xs text-muted-foreground">{row.note}</div> : null}
          </div>
        </div>
      ))}
    </div>
  )
})
