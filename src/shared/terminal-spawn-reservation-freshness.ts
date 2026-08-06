export function terminalSpawnReservationFreshness(args: {
  workspaceFreshness: string | null
  reconnectGeneration: number | null
}): string | null {
  if (args.workspaceFreshness === null && args.reconnectGeneration === null) {
    return null
  }
  return JSON.stringify([args.workspaceFreshness, args.reconnectGeneration])
}
