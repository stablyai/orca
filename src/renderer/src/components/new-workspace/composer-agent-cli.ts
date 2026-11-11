// The closed agent picker says "Claude (CLI)" only when the same agent also has a chat to tell it
// apart from. Orca Cloud is terminal-only, so its one Claude is just "Claude" (PC-9).
export function composerAgentSelection<T extends { cli?: boolean }>(
  selection: T,
  orcaCloud: boolean
): T {
  return orcaCloud && selection.cli ? { ...selection, cli: false } : selection
}
