export function commanderTaskSpec(spec: string, commander?: { guidelines: string }): string {
  return commander?.guidelines ? `${spec}\n\n${commander.guidelines}` : spec
}
