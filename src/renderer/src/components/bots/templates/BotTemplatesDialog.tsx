// Bot templates: a large dialog over the app with the Setup guide's frame. One list in category order
// (search, category chips, sticky headings) beside the selected template's detail; when the dialog is
// narrow the detail opens in place of the list. Use opens New bot over it, prefilled: nothing is made
// before its Create.
import { useEffect, useRef, useState } from 'react'
import {
  Bell,
  ChevronLeft,
  CodeXml,
  FileText,
  LayoutGrid,
  Link2,
  MessagesSquare,
  Plus,
  Rocket,
  Search,
  Wrench,
  X
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { useBots } from '@/lib/bot-catalog'
import { useAppStore } from '@/store'
import { NewBotDialog } from '../NewBotDialog'
import { openBotShareLink } from '../sharing/bot-share-receive-open'
import { templateProposal } from '../../../../../shared/bots/bot-proposal'
import {
  BOT_TEMPLATE_CATEGORIES,
  type BotTemplate,
  type BotTemplateCategory
} from '../../../../../shared/bots/bot-templates'
import {
  botTemplateGroups,
  botTemplateMatches,
  freeBotName
} from '../../../../../shared/bots/bot-template-view'
import { BotTemplateDetail } from './BotTemplateDetail'
import { BotTemplateRow } from './BotTemplateRow'
import { botTemplateCategoryLabel } from './bot-template-labels'
import { BotTemplatesEmpty } from './BotTemplatesEmpty'

// Below this dialog width the detail column folds away (the @max-[56rem] classes, 896px) and a row opens
// the detail in place of the list.
const DETAIL_COLUMN_MIN_WIDTH = 896

const CATEGORY_ICONS = {
  coding: CodeXml,
  releases: Rocket,
  support: MessagesSquare,
  planning: FileText,
  ops: Wrench,
  personal: Bell
}

/** Mounted only while `activeModal` is 'bot-templates', so search, scroll and the in-place detail start fresh. */
export default function BotTemplatesDialog(): React.JSX.Element {
  const closeModal = useAppStore((state) => state.closeModal)
  return (
    <Dialog open onOpenChange={(next) => (next ? null : closeModal())}>
      <BotTemplatesDialogContent onClose={closeModal} />
    </Dialog>
  )
}

type Creating = { template: BotTemplate | null; purpose?: string }

function BotTemplatesDialogContent({ onClose }: { onClose: () => void }): React.JSX.Element {
  const t = useTranslate()
  const asked = useAppStore((state) =>
    typeof state.modalData.templateId === 'string' ? state.modalData.templateId : null
  )
  const lastSelected = useAppStore((state) => state.botTemplateSelected)
  const remember = useAppStore((state) => state.selectBotTemplate)
  const botNames = useBots().map((bot) => bot.name)
  const [picked, setPicked] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<BotTemplateCategory | null>(null)
  const [inPlace, setInPlace] = useState(false)
  const [creating, setCreating] = useState<Creating | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const rows = useRef(new Map<string, HTMLDivElement>())
  const invoker = useRef<HTMLElement | null>(null)

  const label = (category: BotTemplateCategory) => botTemplateCategoryLabel(category, t)
  const groups = botTemplateGroups(
    (template) =>
      (!category || template.category === category) && botTemplateMatches(template, query, label)
  )
  const shown = groups.flatMap((group) => group.templates)
  const selectedId = picked ?? asked ?? lastSelected
  const selected = shown.find((template) => template.id === selectedId) ?? shown[0] ?? null

  const pick = (template: BotTemplate): void => {
    setPicked(template.id)
    remember(template.id)
  }
  const select = (template: BotTemplate): void => {
    pick(template)
    rows.current.get(template.id)?.scrollIntoView({ block: 'nearest' })
  }
  // Focus goes back to what opened New bot: the row, a Use button, Blank bot or the search, all still shown.
  const openNewBot = (next: Creating): void => {
    invoker.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setCreating(next)
  }
  const startFrom = (template: BotTemplate): void => openNewBot({ template })
  const narrow = (): boolean => (contentRef.current?.clientWidth ?? 0) < DETAIL_COLUMN_MIN_WIDTH

  // Grown back past the fold, the detail column shows again; narrowing later starts from the list.
  useEffect(() => {
    const content = contentRef.current
    if (!inPlace || !content) {
      return
    }
    const observer = new ResizeObserver(() => {
      if (content.clientWidth >= DETAIL_COLUMN_MIN_WIDTH) {
        setInPlace(false)
      }
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [inPlace])

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (inPlace && narrow()) {
      return
    }
    const typing = event.target === searchRef.current
    if (event.key === '/' && !typing) {
      event.preventDefault()
      searchRef.current?.focus()
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && selected) {
      event.preventDefault()
      const at = shown.indexOf(selected) + (event.key === 'ArrowDown' ? 1 : -1)
      const next = shown[Math.max(0, Math.min(shown.length - 1, at))]
      if (next) {
        select(next)
        if (!typing) {
          rows.current.get(next.id)?.focus()
        }
      }
    } else if (event.key === 'Enter' && selected && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault()
      startFrom(selected)
    }
  }

  return (
    <>
      <DialogContent
        ref={contentRef}
        surface="opaque-panel"
        showCloseButton={false}
        aria-describedby={undefined}
        className="@container grid h-[min(780px,calc(100vh-2rem))] w-[min(1400px,calc(100vw-2rem))] max-w-none grid-rows-[auto_minmax(0,1fr)] sm:max-w-none"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          searchRef.current?.focus()
          // Opened on a template (Cmd+J, or the last one shown): bring its row into view.
          if (selected) {
            rows.current.get(selected.id)?.scrollIntoView({ block: 'center' })
          }
        }}
        onEscapeKeyDown={(event) => {
          // A typed search clears first; the next Esc closes.
          if (query) {
            event.preventDefault()
            setQuery('')
          }
        }}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 border-b border-border py-3.5 pr-4 pl-6">
          <DialogTitle className="min-w-0 flex-1">
            {t('bots.templates.title', 'Bot templates')}
          </DialogTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onClose()
              openBotShareLink(null)
            }}
          >
            <Link2 className="size-4" />
            {t('bots.templates.fromLink', 'From a link')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => openNewBot({ template: null })}>
            <Plus className="size-4" />
            {t('bots.templates.blank', 'Blank bot')}
          </Button>
          <div className="mx-1 h-5 w-px bg-border/50" aria-hidden />
          <Tooltip>
            <TooltipTrigger asChild>
              <DialogClose asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('bots.templates.close', 'Close')}
                >
                  <X className="size-4" />
                </Button>
              </DialogClose>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {t('bots.templates.closeTooltip', 'Close · Esc')}
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex min-h-0">
          {/* Narrow toggles sit on wrappers without a display class, so the two never compete. */}
          <div className={cn('min-w-0 flex-1', inPlace && '@max-[56rem]:hidden')}>
            <div className="flex h-full flex-col">
              <div className="shrink-0 px-6 pt-4 pb-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    ref={searchRef}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('bots.templates.search', 'Search templates')}
                    aria-label={t('bots.templates.search', 'Search templates')}
                    inset="leadingIcon"
                  />
                </div>
                <ToggleGroup
                  type="single"
                  orientation="horizontal"
                  variant="chip"
                  size="xs"
                  spacing={1.5}
                  value={category ?? 'all'}
                  aria-label={t('bots.templates.filterCategory', 'Filter by category')}
                  className="mt-2 w-full flex-wrap"
                  onValueChange={(value) => {
                    setCategory(BOT_TEMPLATE_CATEGORIES.find((option) => option === value) ?? null)
                    listRef.current?.scrollTo({ top: 0 })
                  }}
                >
                  <ToggleGroupItem value="all">
                    <LayoutGrid className="size-3" aria-hidden />
                    {t('bots.templates.allCategories', 'All')}
                  </ToggleGroupItem>
                  {BOT_TEMPLATE_CATEGORIES.map((option) => {
                    const Icon = CATEGORY_ICONS[option]
                    return (
                      <ToggleGroupItem key={option} value={option}>
                        <Icon className="size-3" aria-hidden />
                        {label(option)}
                      </ToggleGroupItem>
                    )
                  })}
                </ToggleGroup>
              </div>
              <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
                {shown.length === 0 ? (
                  <BotTemplatesEmpty
                    query={query}
                    onClear={() => {
                      setQuery('')
                      searchRef.current?.focus()
                    }}
                    onBlank={() => openNewBot({ template: null, purpose: query.trim() })}
                  />
                ) : (
                  <div
                    role="listbox"
                    aria-label={t('bots.templates.title', 'Bot templates')}
                    className="px-6 pb-8"
                  >
                    {groups.map((group) => (
                      <section key={group.category} role="group" aria-label={label(group.category)}>
                        <h2 className="sticky top-0 z-[5] bg-popover py-2 text-xs font-medium text-muted-foreground">
                          {label(group.category)}
                        </h2>
                        {group.templates.map((template) => (
                          <BotTemplateRow
                            key={template.id}
                            template={template}
                            current={template.id === selected?.id}
                            rowRef={(element) => {
                              if (element) {
                                rows.current.set(template.id, element)
                              } else {
                                rows.current.delete(template.id)
                              }
                            }}
                            onSelect={() => {
                              pick(template)
                              if (narrow()) {
                                setInPlace(true)
                              }
                            }}
                            onUse={() => startFrom(template)}
                          />
                        ))}
                      </section>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
          {selected && inPlace ? (
            <div className="min-w-0 flex-1 @min-[56rem]:hidden">
              <div className="flex h-full flex-col">
                <div className="shrink-0 px-4 pt-3">
                  <Button variant="ghost" size="xs" onClick={() => setInPlace(false)}>
                    <ChevronLeft />
                    {t('bots.templates.allTemplates', 'All templates')}
                  </Button>
                </div>
                <BotTemplateDetail
                  key={selected.id}
                  template={selected}
                  onUse={() => startFrom(selected)}
                />
              </div>
            </div>
          ) : null}
          {selected ? (
            <aside className="w-[30%] min-w-100 shrink-0 border-l border-border @max-[56rem]:hidden">
              <div className="flex h-full flex-col">
                <BotTemplateDetail
                  key={selected.id}
                  template={selected}
                  onUse={() => startFrom(selected)}
                />
              </div>
            </aside>
          ) : null}
        </div>
      </DialogContent>
      {/* A sibling, not a child, so its keys and Esc never reach the templates list under it. */}
      {creating ? (
        <NewBotDialog
          open
          onOpenChange={(next) => (next ? null : setCreating(null))}
          proposal={
            creating.template
              ? templateProposal(creating.template, {
                  name: freeBotName(creating.template.name, botNames)
                })
              : undefined
          }
          initialPurpose={creating.purpose}
          origin={
            creating.template
              ? t('bots.templates.originTemplateNamed', 'From the {{template}} template', {
                  template: creating.template.name
                })
              : undefined
          }
          returnFocusTo={invoker}
          // New bot has opened the bot's page by now.
          onCreated={onClose}
        />
      ) : null}
    </>
  )
}
