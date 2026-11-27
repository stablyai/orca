import React, { useRef, useState } from 'react'
import { Plus, Search } from 'lucide-react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/class-names'
import {
  LIST_TABLE_HEADER_CLASS,
  LIST_TABLE_ROW_CLASS,
  LIST_TABLE_ROW_DIVIDER_CLASS
} from '@/lib/list-interaction/list-table-layout'
import { RailPage, RailPageBody, RailPageNotice } from './RailPage'
import {
  RailPageHeader,
  RailPageMoreMenu,
  RailPagePrimaryButton,
  RailPageRefreshButton
} from './RailPageHeader'
import { RailPageFilterButton, RailPageToolbar, RailPageViews } from './RailPageToolbar'
import { RailPageSearch } from './RailPageSearch'

// Clearly invented rows: the template's shape only, no product data.
const ROWS = Array.from({ length: 20 }, (_, index) => ({
  id: `row-${index + 1}`,
  name: `Example item ${index + 1}`,
  kind: index % 3 === 0 ? 'Alpha' : index % 3 === 1 ? 'Beta' : 'Gamma',
  updated: `${index + 1}d ago`
}))
const GRID = 'grid grid-cols-[minmax(0,1fr)_6rem_6rem]'

function TemplateFrame({ rows, notice }: { rows: number; notice?: boolean }): React.JSX.Element {
  const [view, setView] = useState<'all' | 'alpha' | 'beta'>('all')
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div className="flex h-[560px] bg-worktree-sidebar">
      <div className="w-10 shrink-0 border-r border-worktree-sidebar-border" />
      <RailPage>
        <RailPageHeader
          title="Example page"
          count={rows}
          scope={<span className="text-xs text-muted-foreground">example/scope</span>}
          actions={
            <>
              <RailPageRefreshButton label="Refresh" busy={false} onRefresh={() => {}} />
              <RailPageMoreMenu>
                <DropdownMenuItem>Secondary action</DropdownMenuItem>
              </RailPageMoreMenu>
              <RailPagePrimaryButton
                icon={<Plus className="size-3.5" />}
                label="New"
                aria-label="New example"
              />
            </>
          }
        />
        <RailPageToolbar
          start={
            <RailPageViews
              label="Views"
              value={view}
              onValueChange={setView}
              items={[
                { value: 'all', label: 'All', count: rows },
                { value: 'alpha', label: 'Alpha', count: Math.ceil(rows / 3) },
                { value: 'beta', label: 'Beta', count: Math.floor(rows / 3), separatorBefore: true }
              ]}
            />
          }
          end={
            <>
              <RailPageFilterButton activeCount={2} />
              <RailPageSearch inputRef={inputRef} hasValue={query !== ''}>
                <div className="relative w-full">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    ref={inputRef}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search..."
                    aria-label="Search"
                    density="compact"
                    inset="leadingIcon"
                    adornment="trailing"
                  />
                </div>
              </RailPageSearch>
            </>
          }
        />
        {notice ? (
          <RailPageNotice>
            <span className="text-xs text-muted-foreground">Status: Example ×</span>
          </RailPageNotice>
        ) : null}
        <RailPageBody>
          <div className="scrollbar-sleek min-h-0 flex-1 overflow-auto">
            <div className={cn(GRID, LIST_TABLE_HEADER_CLASS)}>
              <span>Name</span>
              <span>Kind</span>
              <span>Updated</span>
            </div>
            {ROWS.slice(0, rows).map((row, index) => (
              <div
                key={row.id}
                className={cn(
                  GRID,
                  LIST_TABLE_ROW_CLASS,
                  index < rows - 1 && LIST_TABLE_ROW_DIVIDER_CLASS
                )}
              >
                <span className="truncate font-medium">{row.name}</span>
                <span className="text-muted-foreground">{row.kind}</span>
                <span className="text-muted-foreground">{row.updated}</span>
              </div>
            ))}
            {rows === 0 ? (
              <p className="px-(--rail-page-gutter) py-6 text-center text-sm text-muted-foreground">
                Nothing here yet
              </p>
            ) : null}
          </div>
        </RailPageBody>
      </RailPage>
    </div>
  )
}

export const full = defineFixture({
  width: 1280,
  render: () => <TemplateFrame rows={20} />
})

export const fullWithNotice = defineFixture({
  width: 1280,
  render: () => <TemplateFrame rows={20} notice />
})

export const empty = defineFixture({
  width: 1280,
  render: () => <TemplateFrame rows={0} />
})

export const narrow = defineFixture({
  width: 560,
  render: () => <TemplateFrame rows={20} notice />
})
