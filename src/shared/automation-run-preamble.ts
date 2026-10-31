// Append versions so saved messages remain recognizable after preamble changes.
export const automationRunPreambleVersions = [
  (cli: string): string => {
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
] as const

export function buildAutomationRunPreamble(cli: string): string {
  const version = automationRunPreambleVersions.at(-1)
  if (!version) {
    throw new Error('Automation preamble versions must not be empty')
  }
  return version(cli)
}

export function splitAutomationRunMessage(
  text: string
): { instructions: string; task: string } | null {
  for (const version of automationRunPreambleVersions) {
    const [beforeCli, afterCli] = version('\0').split('\0')
    if (!afterCli || !text.startsWith(beforeCli)) {
      continue
    }
    const cliEnd = text.indexOf(afterCli, beforeCli.length)
    if (cliEnd <= beforeCli.length) {
      continue
    }
    const preamble = version(text.slice(beforeCli.length, cliEnd))
    if (text.startsWith(preamble)) {
      return {
        instructions: preamble.slice(0, -'=== TASK ===\n'.length).trimEnd(),
        task: text.slice(preamble.length)
      }
    }
  }
  return null
}
