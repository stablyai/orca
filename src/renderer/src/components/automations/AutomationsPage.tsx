import { AutomationsPageSurface } from './AutomationsPageSurface'
import { useAutomationsPageController } from './use-automations-page-controller'

export default function AutomationsPage(): React.JSX.Element {
  const controller = useAutomationsPageController()
  return <AutomationsPageSurface controller={controller} />
}
