export async function resolveWorktreeCreateBaseBranch(args: {
  explicitBaseBranch: string | undefined
}): Promise<string | undefined> {
  return args.explicitBaseBranch?.trim() || undefined
}
