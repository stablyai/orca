import { translate } from '@/i18n/i18n'

export async function resolveWorktreeCreateBaseBranch(args: {
  explicitBaseBranch: string | undefined
}): Promise<string> {
  const baseline = args.explicitBaseBranch?.trim()
  if (!baseline) {
    throw new Error(
      translate(
        'workspace.baseline.required',
        'Select a baseline branch before creating a workspace.'
      )
    )
  }
  return baseline
}
