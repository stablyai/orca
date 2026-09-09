import { renderIssueCommandTemplate } from '@/lib/new-workspace'

export function buildFullCreationIssueCommand(args: {
  shouldRun: boolean
  template: string
  issueNumber: number | null | undefined
  artifactUrl: string | null | undefined
}): { command: string } | undefined {
  if (!args.shouldRun) {
    return undefined
  }
  return {
    command: renderIssueCommandTemplate(args.template, {
      issueNumber: args.issueNumber ?? null,
      artifactUrl: args.artifactUrl ?? null
    })
  }
}
