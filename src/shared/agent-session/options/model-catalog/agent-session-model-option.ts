import type { AgentSessionOptionChoice } from '../../agent-session-wire'

export type AgentSessionModelOption = {
  resolvedModel?: string | null
  effortsKnown?: false
  id: string
  label: string
  description?: string
  isDefault: boolean
  defaultEffort?: string
  /** Transient display declaration; null is observed unknown, absence supplies no evidence. */
  declaredDefaultEffort?: string | null
  efforts: AgentSessionOptionChoice[]
  /** Additional structured-chat choices; never CLI effort arguments. Older hosts omit this. */
  chatEfforts?: AgentSessionOptionChoice[]
  /** Provider catalog fact. Absent means the host could not determine support. */
  supportsFastMode?: boolean
  /** Whether this model runs Fast until the person picks; absent is off. */
  defaultFastMode?: boolean
  /** Context sizes the provider lists for this model; empty is none, absent is unobserved or an older host. */
  contextWindows?: AgentSessionOptionChoice[]
  /** The size this model runs until the person picks. */
  defaultContextWindow?: string
  /** Whether the model runs Approve for me; absent is unknown, which neither offers nor launches it. */
  supportsAutoMode?: boolean
  /** Provider tier IDs beyond standard; capable clients replace Fast with one speed choice including default. Absence means unknown. */
  serviceTiers?: AgentSessionOptionChoice[]
}
