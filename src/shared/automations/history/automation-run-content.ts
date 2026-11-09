type AutomationRunContentSource = {
  outputSnapshot?: { content: string } | null
  precheckResult?: { stdout: string; stderr: string } | null
  error?: string | null
  usage?: { unavailableMessage?: string | null } | null
}

export function getAutomationRunContent(
  run: AutomationRunContentSource,
  noOutputContent = 'No output content available.'
): string {
  const savedOutput = run.outputSnapshot?.content.trim()
  if (savedOutput) {
    return run.outputSnapshot?.content ?? savedOutput
  }
  if (run.precheckResult) {
    const output = [run.precheckResult.stderr.trim(), run.precheckResult.stdout.trim()]
      .filter(Boolean)
      .join('\n\n')
    if (output) {
      return output
    }
  }
  return run.error ?? run.usage?.unavailableMessage ?? noOutputContent
}
