export type AgentSessionOptionChoice = {
  value: string
  label: string
  description?: string
}

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
  /** The chat offers an Ultracode switch beside any effort, replacing `chatEfforts`. Older hosts omit this. */
  supportsUltracode?: boolean
  /** Provider catalog fact. Absent means the host could not determine support. */
  supportsFastMode?: boolean
  /** Whether the model runs Approve for me; absent is unknown, which neither offers nor launches it. */
  supportsAutoMode?: boolean
  /** Provider tier IDs beyond standard; capable clients replace Fast with one speed choice including default. Absence means unknown. */
  serviceTiers?: AgentSessionOptionChoice[]
}
