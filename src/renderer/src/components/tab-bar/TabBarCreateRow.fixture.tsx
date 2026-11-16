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
  Workflow
} from 'lucide-react'
import { defineFixture } from '../../component-fixtures/component-fixture'
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

// Plugin file types are what push the row past the menu's width in practice.
const PLUGIN_FILES: TabBarCreateRowItem[] = [
  ['excalidraw', 'New Excalidraw', 'Excalidraw', PenTool],
  ['drawio', 'New Diagram', 'Draw.io', Network],
  ['sheet', 'New Spreadsheet', 'Sheets', Sheet],
  ['slides', 'New Slides', 'Slides', Presentation],
  ['kanban', 'New Board', 'Kanban', Kanban],
  ['flow', 'New Flowchart', 'Mermaid', Workflow],
  ['canvas', 'New Image Canvas', 'Canvas', Image],
  ['snippet', 'New Snippet', 'Snippets', Code]
].map(([key, label, plugin, Icon]) => ({
  id: `plugin-file:${String(key)}`,
  label: String(label),
  detail: String(plugin),
  icon: typeof Icon === 'string' ? null : <Icon className={ICON} />,
  run: noop
}))

function Menu({ items }: { items: TabBarCreateRowItem[] }): React.JSX.Element {
  return (
    <div className="flex h-[260px] items-start bg-background p-3">
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>+</DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <div className="-mx-1 -mt-1 flex h-9 items-center px-3 text-xs text-muted-foreground">
            Search tabs, files, URLs, agents…
          </div>
          <DropdownMenuSeparator className="my-0 mb-1.5" />
          <TabBarCreateRow items={items} customizable />
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
