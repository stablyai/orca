import { DndContext } from '@dnd-kit/core'
import { defineFixture } from '../../component-fixtures/component-fixture'
import type { ProviderRateLimits } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { NativeChatAgentControls } from '../native-chat/messages/actions/NativeChatAgentControls'
import { NativeChatForkAction } from '../native-chat/messages/actions/NativeChatForkAction'
import { SidebarSectionHeader } from '../sidebar/SidebarSectionHeader'
import { ProviderSegment } from '../status-bar/usage/StatusBarProviderSegment'
import { UsageOverflowChip } from '../status-bar/usage/usage-overflow-chip'

const CURSOR: ProviderRateLimits = {
  provider: 'cursor',
  status: 'ok',
  session: null,
  weekly: null,
  monthly: { usedPercent: 0, windowMinutes: 43_200, resetsAt: null, resetDescription: null },
  updatedAt: Date.now(),
  error: null
}

function ReportedControls(): React.JSX.Element {
  return (
    <div className="flex h-64 flex-col justify-center gap-4 bg-background p-6 text-foreground">
      <div className="native-chat-appearance">
        <NativeChatAgentControls
          markdown="The tooltip follow-up is ready."
          timestamp={1_800_000_000_000}
          onScrollToTop={() => undefined}
          action={
            <NativeChatForkAction
              itemId="reply"
              fork={{
                support: { kind: 'known', fork: 'checkpoint' },
                pendingItemId: null,
                request: async () => undefined
              }}
            />
          }
        />
      </div>
      <div className="flex items-center gap-3 text-xs">
        <span data-fixture-provider="" className="inline-flex">
          <ProviderSegment p={CURSOR} mode="compact" display="used" hostLabel="build-box" />
        </span>
        <span data-fixture-overflow="" className="inline-flex">
          <UsageOverflowChip
            hidden={[CURSOR]}
            providerCount={3}
            display="used"
            hostLabel="build-box"
          />
        </span>
      </div>
      <DndContext>
        <SidebarSectionHeader
          title="Bots"
          sectionId="bots"
          actions={null}
          fold={{ collapsed: false, label: 'Collapse Bots', onToggle: () => undefined }}
        />
      </DndContext>
    </div>
  )
}

function hoveredControl(selector: string) {
  return defineFixture({
    width: 640,
    render: () => <ReportedControls />,
    interact: async (frame) => {
      const target = frame.querySelector(selector)
      if (!target) {
        throw new Error(`Missing tooltip target: ${selector}`)
      }
      const rect = target.getBoundingClientRect()
      const pointer = {
        bubbles: true,
        pointerType: 'mouse',
        clientX: rect.x + rect.width / 2,
        clientY: rect.y + rect.height / 2
      }
      target.dispatchEvent(new PointerEvent('pointerover', pointer))
      target.dispatchEvent(new PointerEvent('pointermove', pointer))
      await new Promise((resolve) => window.setTimeout(resolve, 750))
    }
  })
}

export const scroll = hoveredControl('[aria-label="Scroll this message to top"]')
export const fork = hoveredControl('[aria-label="Fork from this response"]')
export const usage = hoveredControl('[data-fixture-provider] > span')
export const overflow = hoveredControl('[data-fixture-overflow] > span')
export const sidebar = hoveredControl('[data-sidebar-section-fold="bots"]')

export const keyboardScroll = defineFixture({
  width: 640,
  render: () => <ReportedControls />,
  interact: (frame) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    frame.querySelector<HTMLButtonElement>('[aria-label="Scroll this message to top"]')?.focus()
  }
})
