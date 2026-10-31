export function buildAutomationRunPreamble(cli: string): string {
  return `You are running an Orca automation. Orca records this run's result: use the
commands below to report to it. They apply to the current run automatically.

=== CLI COMMANDS ===

\`\`\`sh
  # The result will be incomplete: a source was unavailable, checks were not run,
  # or you used an allowed lower-quality fallback. Report it as soon as you know.
  # Reuse the same --key for the same problem; do not create a new key per retry.
  # Optional: --impact, and --evidence or --evidence-file (sends the file's tail).
  ${cli} automations warn --key "<short-id>" --message "<what is missing>"

  # The missing work later succeeded in this run:
  ${cli} automations warn --key "<short-id>" --resolve

  # You cannot do the task at all. Orca marks the run failed with this reason:
  ${cli} automations fail --message "<why the task could not be done>"

  # Only when the task asks for a report. One self-contained .html or .md file:
  # no external fonts, images, styles or scripts; readable on a narrow screen.
  # Optionally add --title.
  ${cli} automations attach --file "<path>"
\`\`\`

Do not warn about transient failures if the final result is complete; warn if a workaround reduces coverage or quality.
Attaching a report does not mark the run successful or clear a warning.

=== TASK ===
`
}

export function splitAutomationRunMessage(
  text: string
): { instructions: string; task: string } | null {
  const cli = /^  (.+) automations warn --key /m.exec(text)?.[1]
  if (!cli) {
    return null
  }
  const preamble = buildAutomationRunPreamble(cli)
  if (!text.startsWith(preamble)) {
    return null
  }
  return {
    instructions: preamble.slice(0, -'=== TASK ===\n'.length).trimEnd(),
    task: text.slice(preamble.length)
  }
}
