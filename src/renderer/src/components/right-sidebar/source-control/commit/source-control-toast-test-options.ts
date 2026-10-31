export type SourceControlToastActionEvent = { preventDefault: () => void }

export type SourceControlToastTestOptions = {
  id?: string
  description?: string
  duration?: number
  action?: { label: string; onClick: (event: SourceControlToastActionEvent) => void }
}
