export type AgentArgsChoice = {
  key: string
  label: string
  flag: string
  onRemove: (text: string) => string
  source?: 'arguments'
}
