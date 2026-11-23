import { defineFixture } from '../../../component-fixtures/component-fixture'
import { AutomationsPageBreadcrumb } from '../AutomationsPageBreadcrumb'
import { AutomationsPageFrame } from '../AutomationsPageFrame'
import { makeAutomation } from '../automations-page-fixtures'
import {
  AutomationDetailActions,
  COPY_URL_COMPACT_HEADER_WIDTH_PX
} from './AutomationDetailActions'

const automation = makeAutomation({ name: 'Failed payment follow-up from the billing webhook' })
const noop = (): void => {}

// The detail page's header for an automation a webhook starts: Copy URL beside Pause and Edit.
function Header(): React.JSX.Element {
  return (
    <div className="bg-background text-foreground">
      <AutomationsPageFrame
        nav={
          <AutomationsPageBreadcrumb
            items={[
              { key: 'root', label: 'Automations', onSelect: noop },
              { key: 'auto', label: automation.name }
            ]}
          />
        }
        compactBelowPx={COPY_URL_COMPACT_HEADER_WIDTH_PX}
        actions={({ compact }) => (
          <AutomationDetailActions
            automation={automation}
            compact={compact}
            runNowAvailability={null}
            isRunNowPending={false}
            onRunNow={noop}
            onEdit={noop}
            onToggle={noop}
            onDelete={noop}
            onCopyUrl={noop}
          />
        )}
      >
        {null}
      </AutomationsPageFrame>
    </div>
  )
}

export const wide = defineFixture({ width: 1000, render: () => <Header /> })

export const justAboveFold = defineFixture({ width: 720, render: () => <Header /> })

export const folded = defineFixture({
  width: 640,
  render: () => <Header />,
  interact: async () => {
    document
      .querySelector<HTMLElement>('button[aria-label="Automation actions"]')
      ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
})
