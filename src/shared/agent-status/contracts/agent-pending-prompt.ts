export type PendingPromptOption = { id: string; label: string; description?: string }

/** Remote-answerable prompts; treat unknown future kinds as unsupported. */
export type PendingPrompt =
  | {
      kind: 'approval'
      promptId: string
      tool: string
      summary?: string
      options: PendingPromptOption[]
    }
  | {
      kind: 'question'
      promptId: string
      question: string
      header?: string
      options: PendingPromptOption[]
    }
  /** The agent is waiting on something only Orca's own views can answer. */
  | { kind: 'unsupported'; promptId: string; text?: string; byReply?: true }
