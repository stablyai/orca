import {
  Code,
  FilePlus,
  FileText,
  Globe,
  Image,
  Kanban,
  Network,
  PenTool,
  Presentation,
  Sheet,
  Smartphone,
  TerminalSquare,
  Workflow,
  type LucideIcon
} from 'lucide-react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { cn } from '@/lib/class-names'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TabBarCreateRow } from './TabBarCreateRow'
import type { TabBarCreateRowItem } from './tab-bar-create-row-item'

const noop = (): void => {}
const ICON = 'size-4'

const BUILT_IN: TabBarCreateRowItem[] = [
  {
    id: 'terminal',
    locked: true,
    label: 'New Terminal',
    icon: <TerminalSquare className={ICON} />,
    actionId: 'tab.newTerminal',
    run: noop
  },
  {
    id: 'browser',
    label: 'New Browser Tab',
    icon: <Globe className={ICON} />,
    actionId: 'tab.newBrowser',
    run: noop
  },
  {
    id: 'markdown',
    label: 'New Markdown',
    icon: <FilePlus className={ICON} />,
    actionId: 'tab.newMarkdown',
    run: noop
  },
  {
    id: 'open-markdown',
    label: 'Open Markdown...',
    icon: <FileText className={ICON} />,
    actionId: 'tab.openMarkdown',
    run: noop
  },
  {
    id: 'mobile-emulator',
    label: 'New Mobile Emulator',
    icon: <Smartphone className={ICON} />,
    actionId: 'tab.newSimulator',
    run: noop
  }
]

const pluginFile = (
  key: string,
  label: string,
  plugin: string,
  Icon: LucideIcon
): TabBarCreateRowItem => ({
  id: `plugin-file:${key}`,
  label,
  detail: plugin,
  icon: <Icon className={ICON} />,
  run: noop
})

// Plugin file types are what push the row past the menu's width in practice.
const PLUGIN_FILES: TabBarCreateRowItem[] = [
  pluginFile('excalidraw', 'New Excalidraw', 'Excalidraw', PenTool),
  pluginFile('drawio', 'New Diagram', 'Draw.io', Network),
  pluginFile('sheet', 'New Spreadsheet', 'Sheets', Sheet),
  pluginFile('slides', 'New Slides', 'Slides', Presentation),
  pluginFile('kanban', 'New Board', 'Kanban', Kanban),
  pluginFile('flow', 'New Flowchart', 'Mermaid', Workflow),
  pluginFile('canvas', 'New Image Canvas', 'Canvas', Image),
  pluginFile('snippet', 'New Snippet', 'Snippets', Code)
]

function Menu({
  items,
  className
}: {
  items: TabBarCreateRowItem[]
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('flex h-[260px] items-start bg-background p-3', className)}>
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>+</DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <div className="-mx-1 -mt-1 flex h-9 items-center px-3 text-xs text-muted-foreground">
            Search tabs, files, URLs, agents…
          </div>
          <DropdownMenuSeparator className="my-0 mb-1.5" />
          <TabBarCreateRow items={items} customizable layoutSetting="newTabMenuLayout" />
          <DropdownMenuSeparator />
          <DropdownMenuItem>Claude</DropdownMenuItem>
          <DropdownMenuItem>Codex</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

const scrollRow = (fraction: number) => async (frame: HTMLElement) => {
  await new Promise((resolve) => requestAnimationFrame(resolve))
  const strip = (frame.ownerDocument ?? document).querySelector<HTMLElement>(
    '[data-variant="icon-row"] .scrollbar-none'
  )
  if (strip) {
    strip.scrollLeft = (strip.scrollWidth - strip.clientWidth) * fraction
  }
  await new Promise((resolve) => setTimeout(resolve, 200))
}

export const fits = defineFixture({ width: 340, render: () => <Menu items={BUILT_IN} /> })

export const overflowStart = defineFixture({
  width: 340,
  render: () => <Menu items={[...BUILT_IN, ...PLUGIN_FILES]} />
})

export const overflowMiddle = defineFixture({
  width: 340,
  render: () => <Menu items={[...BUILT_IN, ...PLUGIN_FILES]} />,
  interact: scrollRow(0.5)
})

export const overflowEnd = defineFixture({
  width: 340,
  render: () => <Menu items={[...BUILT_IN, ...PLUGIN_FILES]} />,
  interact: scrollRow(1)
})

export const customizer = defineFixture({
  width: 640,
  render: () => <Menu items={BUILT_IN} className="h-[340px]" />,
  interact: async (frame) => {
    await new Promise(requestAnimationFrame)
    const trigger = frame.ownerDocument.querySelector<HTMLElement>(
      '[data-slot="dropdown-menu-sub-trigger"]'
    )
    trigger?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
    trigger?.click()
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
})

export const customizerHiddenTooltip = defineFixture({
  ...customizer,
  interact: async (frame) => {
    await customizer.interact?.(frame)
    const infoButton = frame.ownerDocument.querySelector<HTMLElement>(
      'button[aria-label="Hidden items still open from search and their shortcuts."]'
    )
    infoButton?.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' })
    )
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
})
