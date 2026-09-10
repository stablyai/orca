export function maestroWorkspaceMutationKey(action: string, identity: string): string {
  return `renderer-${action}-${identity}-${crypto.randomUUID()}`
}
