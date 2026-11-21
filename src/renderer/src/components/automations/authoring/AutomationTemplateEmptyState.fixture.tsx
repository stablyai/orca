import { defineFixture } from '../../../component-fixtures/component-fixture'
import { AutomationTemplateEmptyState } from './AutomationTemplateEmptyState'

export const templates = defineFixture({
  width: 720,
  render: () => <AutomationTemplateEmptyState onOpenCreate={() => {}} />
})
