/** The tool's own name when the provider gave one; otherwise the prompt's title as it read. */
export function approvalRecordTool(toolName: string | undefined, title: string): string {
  return toolName?.trim() || title
}
