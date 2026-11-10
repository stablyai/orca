import {
  modelCatalogSource,
  type ModelCatalogSource
} from '../../../../shared/agent-session/options/model-catalog-source'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import type { AgentPickerAcquisitionObserver } from './agent-picker-inventory-source'

export function agentPickerCatalogDemanded(
  entry: AgentPickerEntry,
  source: ModelCatalogSource,
  observers: Iterable<AgentPickerAcquisitionObserver>
) {
  return [...observers].some(
    (observer) =>
      observer.usesSource?.(entry, source) ??
      (source !== 'cli' || modelCatalogSource(entry.agent, entry.defaultSurface) === source)
  )
}

export class AgentPickerSourceDemand {
  private controllers = new Map<number, AbortController>()
  signal(index: number) {
    let controller = this.controllers.get(index)
    if (!controller) {
      controller = new AbortController()
      this.controllers.set(index, controller)
    }
    return controller.signal
  }
  reconcile(uses: (index: number) => boolean) {
    for (const [index, controller] of this.controllers) {
      if (!uses(index)) {
        this.controllers.delete(index)
        controller.abort()
      }
    }
  }
}
