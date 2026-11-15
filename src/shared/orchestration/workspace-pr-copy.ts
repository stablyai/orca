import { quoteStartupArg } from '../agent-launch/startup/tui-agent-startup-shell'
export const workspacePrCopy = {
  summary: 'Adopt an existing git worktree into Orca.',
  usage: 'orca worktree adopt --path <path> --parent-worktree <selector> [--json]',
  pathHelp: 'Path to an existing git worktree.',
  parentHelp: 'Parent workspace selector (required).',
  preamble: (
    cli: string,
    name: string,
    path: string,
    id: string,
    parentArgument = quoteStartupArg(`id:${id}`, 'posix')
  ) => `=== YOUR WORKSPACE ===
Your Orca workspace is ${name}, at ${path}.
For changes and pull requests in another registered project, create a workspace:
  ${cli} worktree create --repo <project> --name <short-name> --parent-worktree ${parentArgument}
Use ${cli} repo list to find projects. If a project is missing or inaccessible, ask your coordinator.
If you already made a git worktree, adopt it before reporting completion:
  ${cli} worktree adopt --path "<path>" --parent-worktree ${parentArgument}
Read-only and test scratch copies are fine anywhere.`,
  worker: (
    ref: string,
    cli: string,
    id: string,
    parentArgument = quoteStartupArg(`id:${id}`, 'posix')
  ) =>
    `Your report names ${ref}, but Orca found no associated workspace for that repository at report time. If you opened it, ask your coordinator to resume you to run: ${cli} worktree adopt --path "<path>" --parent-worktree ${parentArgument}`,
  coordinator: (ref: string, cli = 'orca') =>
    `Orca: At report time, ${ref} had no associated workspace for this worker. If the worker opened it, resume it to adopt the worktree with ${cli} worktree adopt.`,
  adopted: (path: string, parent: string) =>
    `Adopted ${path} under ${parent}. It is visible in Orca; pull requests and checks use the workspace's usual tracking.`,
  already: (path: string, parent: string) => `${path} is already visible in Orca under ${parent}.`,
  not_a_project_worktree: (path: string) =>
    `${path} is not a git worktree of a registered project on this host. Ask your coordinator.`,
  main_checkout: (path: string, cli = 'orca') =>
    `${path} is the project's main checkout. Use ${cli} worktree create for your change.`,
  parent_required: () => 'Choose a parent with --parent-worktree "id:<workspace id>".',
  parent_unavailable: () =>
    'Orca could not verify the worktree and parent on the same host and store. Check both selectors and try again.',
  parent_cycle: () => 'That parent would create a workspace lineage cycle. Choose another parent.',
  ownership_conflict: (path: string) =>
    `${path} has existing task ownership or conflicting workspace records. Orca did not change it. Ask your coordinator.`,
  parent_conflict: (path: string) =>
    `${path} is already linked to a different parent. Orca did not change it. Ask your coordinator.`,
  adopt_failed: (path: string) =>
    `Orca could not finish adopting ${path}. Retry the same command to repair any incomplete adoption.`
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
          `${ref.forgeHost === 'github.com' ? '' : `${ref.forgeHost}/`}${ref.owner}/${ref.repo}#${ref.number}`,
          cli
        )
      ]
    })
  } catch {
    return []
  }
}
