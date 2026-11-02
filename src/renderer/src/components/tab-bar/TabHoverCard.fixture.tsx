import { Terminal } from 'lucide-react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { TabHoverCard } from './TabHoverCard'
import { TabStripTooltipProvider } from './TabStripTooltipProvider'
import { TAB_LABEL_WIDTH_CLASSES } from './tab-width-rules'

function preview(width: number): React.JSX.Element {
  return (
    <div className="h-48 p-4">
      <TabStripTooltipProvider>
        <TabHoverCard title="Codex Chat" programName="Codex" icon={<Terminal className="size-4" />}>
          <div
            tabIndex={0}
            style={{ width }}
            className="flex h-8 items-center gap-1 border border-border bg-background px-2 text-xs text-foreground"
          >
            <Terminal className="size-3 shrink-0" />
            <span className={TAB_LABEL_WIDTH_CLASSES}>Codex Chat</span>
          </div>
        </TabHoverCard>
      </TabStripTooltipProvider>
    </div>
  )
}

export const fullTitle = defineFixture({
  width: 400,
  render: () => preview(300),
  interact: (frame) => {
    frame.querySelector<HTMLElement>('[tabindex]')?.focus()
    if (document.querySelector('[data-tab-hover-card]')) {
      throw new Error('Full title should not open a preview')
    }
  }
})

export const clippedTitle = defineFixture({
  width: 400,
  render: () => preview(80),
  interact: (frame) => {
    frame.querySelector<HTMLElement>('[tabindex]')?.focus()
  }
})

export const widenedTitle = defineFixture({
  width: 400,
  render: () => preview(80),
  interact: async (frame) => {
    const tab = frame.querySelector<HTMLElement>('[tabindex]')
    tab?.focus()
    await new Promise(requestAnimationFrame)
    if (!document.querySelector('[data-tab-hover-card]')) {
      throw new Error('Clipped title should open a preview')
    }
    if (tab) {
      tab.style.width = '300px'
    }
    await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)
    if (document.querySelector('[data-tab-hover-card]')) {
      throw new Error('Widening the tab should close its preview')
    }
  }
})
