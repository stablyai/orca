import { defineFixture } from '../../../component-fixtures/component-fixture'
import { BOT_MCP_APPS } from '../../../../../shared/bots/bot-mcp-apps'
import { BotAppBrandLogo } from './BotAppBrandLogo'
import { BotAppStepHeader } from './BotAppStepParts'
import { BotAppUrlVariableForm } from './BotAppUrlVariableForm'

const step = (id: string) => {
  const app = BOT_MCP_APPS.find((entry) => entry.id === id)!
  return (
    <div className="rounded-xl border bg-card">
      <BotAppStepHeader onBack={() => {}} onClose={() => {}} />
      <BotAppUrlVariableForm
        className="px-6 pt-1 pb-6"
        app={{ ...app, title: app.name, logo: <BotAppBrandLogo app={app} size="lg" /> }}
        variable={app.variable!}
        onAdd={() => {}}
      />
    </div>
  )
}

const click = async (element: HTMLElement | null): Promise<void> => {
  element?.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })
  )
  element?.click()
  await new Promise((resolve) => setTimeout(resolve, 300))
}

// Datadog's site step, US1 preselected.
export const datadog = defineFixture({ width: 460, render: () => step('datadog') })

// Its site list open.
export const datadogOpen = defineFixture({
  width: 460,
  render: () => <div className="pb-72">{step('datadog')}</div>,
  interact: (frame) => click(frame.querySelector('[data-slot="select-trigger"]'))
})

// GitLab's step: Advanced collapsed.
export const gitlab = defineFixture({ width: 460, render: () => step('gitlab') })

// Advanced open: the optional host field, empty.
export const gitlabAdvanced = defineFixture({
  width: 460,
  render: () => step('gitlab'),
  interact: (frame) => click(frame.querySelector('[aria-expanded]'))
})
