/** One workflow-wait recipe for bot rules and trigger-options, including the post-save fallback. */
export function workflowWaitRecipe(orca: string): string {
  return [
    'To wait on one GitHub Actions run, first check that trigger-options lists github.workflow_finished; otherwise offer a deadline-only reminder without promising a completion watch. Choose the filter before saving; for failure only use contains="[conclusion=failure]".',
    'Dispatch with `gh workflow run <workflow> -R github.com/<owner/repo> --ref <ref>` and use its exact run link when available.',
    'If dispatch succeeds without a link, report that no wait was created and ask for the exact link; recover it only from a unique input already supplied in that dispatch and shown in its run-name, using `gh run list -R github.com/<owner/repo>` with a complete search of the dispatch window.',
    'Zero, multiple or incomplete matches mean no wait; never choose the latest run or dispatch again to obtain a link.',
    'For the repository named by the exact run link, keep the run ID and immutable repository ID from `gh api --hostname github.com repos/<owner>/<repo> --jq "{id,full_name}"` and the saved rule’s GitHub repo ref, not a repository inferred from your home folder or another checkout.',
    `Build the complete --on rule first: use github.workflow_finished run=<link> with no contains= for any result, or add the chosen contains= before saving. Save \`${orca} automations create --bot <you> --name "Run <id>" --once --by <expected finish plus margin> --on "<chosen complete rule>" --prompt "<run ID, immutable repo ID, exact complete --on rule, and deadline instructions>"\`, using that chosen rule; keep the returned wait ID and verify its saved repo ref names that same repository ID; if identity cannot be verified, keep the wait and report the uncertainty.`,
    'If saving fails, report that no wait was created; do not claim to be watching.',
    'For the one post-save check, resolve that same repo ID with `gh api --hostname github.com repositories/<repo-id> --jq .full_name`, then run `gh run view <id> -R github.com/<name returned for that repo ID> --json status,conclusion`.',
    `Only if status is completed and the saved filter is proven to match, report it and remove that saved wait ID with \`${orca} automations remove <wait-id>\`: without a contains filter, every completed conclusion matches; a filter consisting exactly of [conclusion=<value>] matches that conclusion case-insensitively.`,
    'A nonmatching conclusion (for example success for a failure-only wait), an incomplete run, a lookup/read error, or a missing/unknown filtered conclusion keeps the wait and its deadline, so a later matching rerun can still fire before the deadline.',
    'For any other contains= text, keep the wait: status/conclusion cannot reproduce the full event text, so do not report a matching completion or remove it from that check.',
    'The saved prompt must preserve the run/repo IDs and exact --on rule, including whether contains= is absent or literal: report a matching event when it wakes; if the deadline wakes it, use the same repo-scoped check and filter and say the deadline expired without a confirmed matching completion on a nonmatch or uncertainty.',
    'Once saved, it wakes on a matching completion or at the deadline; a deadline wake does not prove the filter matched.'
  ].join(' ')
}
