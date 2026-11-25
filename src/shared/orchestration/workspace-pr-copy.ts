import { quoteStartupArg } from '../agent-launch/startup/tui-agent-startup-shell'
import { displayPrRepo } from './workspace-pr-refs'
// Placeholders the reader fills in say so (<your-worktree-path>, <parent-workspace-id>); bare ones
// such as <path> and <workspace id> in the design copy are values Orca substitutes.
export const workspacePrCopy = {
  summary: 'Adopt an existing git worktree into Orca.',
  usage: 'orca worktree adopt --path <path> --parent-worktree <selector> [--json]',
  pathHelp: 'Path to an existing git worktree.',
  parentHelp: 'Parent workspace selector (required), for example "id:<parent-workspace-id>".',
  preamble: (
    cli: string,
    name: string,
    path: string,
    id: string,
    parentArgument = quoteStartupArg(`id:${id}`, 'posix')
  ) => `=== YOUR WORKSPACE ===
Your Orca workspace is ${name}, at ${path}.
For changes and pull requests in ${id.startsWith('folder:') ? 'a' : 'another'} registered project, create a workspace:
  ${cli} worktree create --repo <project> --name <short-name> --parent-worktree ${parentArgument}
Use ${cli} repo list to find projects. If a project is missing or inaccessible, ask your coordinator.
If you already made a git worktree, adopt it before reporting completion:
  ${cli} worktree adopt --path "<your-worktree-path>" --parent-worktree ${parentArgument}
Read-only and test scratch copies are fine anywhere, but don't push from them or open PRs from them.`,
  worker: (
    repo: string,
    number: number,
    cli: string,
    id: string,
    parentArgument = quoteStartupArg(`id:${id}`, 'posix')
  ) =>
    `At report time, Orca found no workspace for ${repo} under your workspace (cited: #${number}). If you opened it, take no action now; your coordinator may resume you to run: ${cli} worktree adopt --path "<your-worktree-path>" --parent-worktree ${parentArgument}`,
  coordinator: (repo: string, number: number, cli = 'orca') =>
    `Orca: At report time, Orca found no workspace for ${repo} under this worker (cited: #${number}). If the worker opened it, resume the worker to run the ${cli} worktree adopt command (with --path and --parent-worktree) from its completion receipt.`,
  adopted: (path: string, parent: string) =>
    `Adopted ${path} under ${parent}. It is visible in Orca; its pull requests and checks follow the worktree's own branch.`,
  already: (path: string, parent: string) => `${path} is already visible in Orca under ${parent}.`,
  not_a_project_worktree: (path: string) =>
    `${path} is not a git worktree of a registered project on this host. Ask your coordinator.`,
  main_checkout: (path: string, cli = 'orca') =>
    `${path} is the project's main checkout. Use ${cli} worktree create for your change.`,
  parent_required: () => 'Choose a parent with --parent-worktree "id:<parent-workspace-id>".',
  parent_unavailable: () =>
    'Orca could not find the worktree and the parent workspace together on this host. Check the --path and --parent-worktree values.',
  parent_cycle: () => 'That parent would create a workspace lineage cycle. Choose another parent.',
  ownership_conflict: (path: string) =>
    `${path} has existing task ownership or conflicting workspace records. Orca did not change it. Ask your coordinator.`,
  parent_conflict: (path: string) =>
    `${path} is already linked to a different parent. Orca did not change it. Ask your coordinator.`,
  adopt_failed: (path: string) =>
    `Orca could not finish adopting ${path}. Retry once; if it fails again, ask your coordinator.`
}

export function reportedWorkspacePrLines(
  payload: string | null | undefined,
  cli = 'orca'
): string[] {
  try {
    const check = JSON.parse(payload ?? '{}').workspaceCheck
    if (check?.version !== 1 || !Array.isArray(check.outside)) {
      return []
    }
    return check.outside.slice(0, 5).flatMap((ref: unknown) => {
      if (
        !ref ||
        typeof ref !== 'object' ||
        !('owner' in ref) ||
        !('repo' in ref) ||
        !('number' in ref) ||
        !('forgeHost' in ref)
      ) {
        return []
      }
      if (
        typeof ref.owner !== 'string' ||
        typeof ref.repo !== 'string' ||
        typeof ref.forgeHost !== 'string' ||
        typeof ref.number !== 'number'
      ) {
        return []
      }
      return [
        workspacePrCopy.coordinator(
          displayPrRepo({ forgeHost: ref.forgeHost, owner: ref.owner, repo: ref.repo }),
          ref.number,
          cli
        )
      ]
    })
  } catch {
    return []
  }
}
