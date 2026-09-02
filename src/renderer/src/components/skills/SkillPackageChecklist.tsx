import { ChevronRight } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { byteLabel } from './skill-share-preview-summary'
import {
  checklistItemSummary,
  type SkillChecklistFile,
  type SkillChecklistItem
} from './skill-package-checklist-items'
import { isSkillBinaryFile, isSkillRunnableFile } from './skill-package-install-risk'

function FileRow({ file }: { file: SkillChecklistFile }): React.JSX.Element {
  const binary = isSkillBinaryFile(file)
  const runnable = isSkillRunnableFile(file)
  const tags = [
    binary ? translate('auto.components.skills.install.fileBinary', 'binary') : null,
    runnable
      ? file.executable
        ? translate('auto.components.skills.share.fileExecutable', 'executable')
        : translate('auto.components.skills.install.fileRunnable', 'runnable')
      : null
  ].filter(Boolean)
  return (
    <li className="flex items-baseline gap-2 text-[11px]">
      <span className="min-w-0 flex-1 break-all font-mono" title={file.path}>
        {file.path}
      </span>
      {tags.length ? (
        <span className="shrink-0 text-muted-foreground">{tags.join(' · ')}</span>
      ) : null}
      <span className="shrink-0 tabular-nums text-muted-foreground">{byteLabel(file.size)}</span>
    </li>
  )
}

function ChecklistRow({
  item,
  selected,
  note,
  busy,
  onSelectedChange
}: {
  item: SkillChecklistItem
  selected: boolean | null
  note: string | null
  busy: boolean
  onSelectedChange?: (selected: boolean) => void
}): React.JSX.Element {
  const summary = checklistItemSummary(item.files)
  const description =
    item.description ||
    translate('auto.components.skills.SkillsPage.9963dff6d3', 'No description found.')
  return (
    <li>
      {/* Why: the description stays on the row and simply unclamps when the row
          opens, so nothing is repeated and nothing is hidden behind a click. */}
      <Collapsible className="group/row">
        <div className="flex items-center gap-3 px-3 py-2">
          {selected !== null ? (
            <Checkbox
              checked={selected}
              disabled={busy}
              aria-label={item.name}
              onCheckedChange={(checked) => onSelectedChange?.(checked === true)}
            />
          ) : null}
          <CollapsibleTrigger
            className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label={`${item.name}, ${summary.label}`}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{item.name}</span>
              {/* Why: unclamped text must contribute its full height to avoid painting over the file list. */}
              <span className="block line-clamp-1 max-h-5 overflow-hidden text-xs leading-5 break-words text-muted-foreground group-data-[state=open]/row:line-clamp-none group-data-[state=open]/row:max-h-none">
                {description}
              </span>
            </span>
            {note ? (
              <span className="shrink-0 text-[11px] text-muted-foreground">{note}</span>
            ) : null}
            <span className="shrink-0 text-[11px] text-muted-foreground">{summary.label}</span>
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/row:rotate-90" />
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent
          className={cn(
            'collapsible-height-content px-3 pb-3',
            selected !== null ? 'pl-10' : 'pl-3'
          )}
        >
          <ul className="scrollbar-sleek max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-2">
            {item.files.map((file) => (
              <FileRow key={file.path} file={file} />
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

/**
 * What the link actually contains: one row per skill, each expandable to its
 * description and file list. Selection is offered only when there is a choice
 * to make — a single-skill package installs as one unit.
 */
export function SkillPackageChecklist({
  items,
  selectedIds,
  notes,
  busy,
  onSelectedChange
}: {
  items: readonly SkillChecklistItem[]
  selectedIds: ReadonlySet<string> | null
  notes?: ReadonlyMap<string, string>
  busy: boolean
  onSelectedChange?: (skillId: string, selected: boolean) => void
}): React.JSX.Element {
  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {items.map((item) => (
        <ChecklistRow
          key={item.id}
          item={item}
          selected={selectedIds ? selectedIds.has(item.id) : null}
          note={notes?.get(item.id) ?? null}
          busy={busy}
          onSelectedChange={(selected) => onSelectedChange?.(item.id, selected)}
        />
      ))}
    </ul>
  )
}
