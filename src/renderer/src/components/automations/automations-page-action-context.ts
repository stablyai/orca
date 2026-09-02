import type { AutomationSourceAvailability } from './use-automation-source-availability'
import type { AutomationsPageListState } from './use-automations-page-list-state'
import type { AutomationsPageLocalState } from './use-automations-page-local-state'
import type { AutomationsPagePresentationState } from './use-automations-page-presentation-state'
import type { AutomationsPageRefresh } from './use-automations-page-refresh'
import type { AutomationsPageSetupState } from './use-automations-page-setup-state'
import type { AutomationsPageStoreState } from './use-automations-page-store-state'
import type { AutomationsPageDestinationState } from './use-automations-page-destination-state'
import type { AutomationsPageDestinationFormState } from './use-automations-page-destination-form'

export type AutomationsPageActionContext = {
  store: AutomationsPageStoreState
  local: AutomationsPageLocalState
  list: AutomationsPageListState
  setup: AutomationsPageSetupState
  destination: AutomationsPageDestinationState
  destinationForm: AutomationsPageDestinationFormState
  sourceAvailability: AutomationSourceAvailability
  presentation: AutomationsPagePresentationState
  pageRefresh: AutomationsPageRefresh
}
