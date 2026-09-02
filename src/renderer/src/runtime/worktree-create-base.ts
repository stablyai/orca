// Backend base resolution owns stale-ref fallback, so the renderer only forwards explicit selections.
export async function resolveWorktreeCreateBaseBranch(args: {
  explicitBaseBranch: string | undefined
}): Promise<string | undefined> {
  return args.explicitBaseBranch?.trim() || undefined
}
