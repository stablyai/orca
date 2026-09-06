import {
  createPanelMessageBudget,
  structuredCloneMessageBytes,
  type PanelMessageBudget
} from './plugin-panel-message-budget'
import { PANEL_MESSAGE_MAX_BYTES, type PluginPanelActionOutcome } from './plugin-panel-bridge'

export type PluginPanelCallRefusal = 'oversized' | 'rate_limited'

export type PluginPanelCallAdmission = {
  admit(pluginKey: string, message: unknown): PluginPanelCallRefusal | null
  clear(pluginKey?: string): void
}

export function admitPluginPanelCall(
  admission: PluginPanelCallAdmission,
  pluginKey: string,
  message: unknown
): PluginPanelActionOutcome | null {
  const refusal = admission.admit(pluginKey, message)
  if (refusal === 'oversized') {
    return { ok: false, code: 'invalid_request', error: 'panel message exceeds the size limit' }
  }
  if (refusal === 'rate_limited') {
    return { ok: false, code: 'rate_limited', error: 'too many panel requests' }
  }
  return null
}

/** Size-only check for host→panel results. Rate is already charged on the
 *  inbound request; a worker-written storage value can still exceed the
 *  64 KiB panel envelope. */
export function admitPluginPanelResult(value: unknown): PluginPanelActionOutcome | null {
  if (structuredCloneMessageBytes(value) > PANEL_MESSAGE_MAX_BYTES) {
    return { ok: false, code: 'invalid_request', error: 'panel message exceeds the size limit' }
  }
  return null
}

type PluginPanelCallAdmissionOptions = {
  limits?: { maxBytes?: number; maxMessages?: number; perMs?: number }
  now?: () => number
}

/** One budget per qualified plugin identity, shared by every panel session
 *  using this transport boundary. */
export function createPluginPanelCallAdmission(
  options: PluginPanelCallAdmissionOptions = {}
): PluginPanelCallAdmission {
  const budgets = new Map<string, PanelMessageBudget>()
  const now = options.now ?? (() => Date.now())
  const budgetFor = (pluginKey: string): PanelMessageBudget => {
    let budget = budgets.get(pluginKey)
    if (!budget) {
      budget = createPanelMessageBudget(options.limits)
      budgets.set(pluginKey, budget)
    }
    return budget
  }
  return {
    admit(pluginKey, message) {
      const budget = budgetFor(pluginKey)
      return budget.admit(now(), structuredCloneMessageBytes(message, budget.maxBytes))
    },
    clear(pluginKey) {
      if (pluginKey === undefined) {
        budgets.clear()
      } else {
        budgets.delete(pluginKey)
      }
    }
  }
}
