// DS-40: "Fix with agent" on a failed Orca Cloud environment build. Opens the composer on Orca Cloud
// with the fix prompt prefilled; the new workspace boots from the environment's last good build
// (or a blank sandbox if none succeeded), the way every new cloud workspace does.
import type { ComposerModalData } from '@/components/new-workspace/composer/composer-modal-data'
import { ORCA_CLOUD_RECIPE_ID } from '../../../shared/hosted-sandbox/orca-cloud-recipe-id'
import { buildCloudEnvironmentFixPrompt } from '../../../shared/cloud-environment-agent-prompt'

export function cloudEnvironmentFixComposerData(args: {
  /** The local project matching the environment's first repo; null lets the user pick. */
  repoId: string | null
  /** The localized first line ("The environment build failed at {{step}}. …"). */
  lead: string
  focus: 'install' | 'clone'
  /** Attached for install failures only; a clone failure is about the repo, not the script. */
  installScript: string
  /** Only the log lines the user can already see in the viewer. */
  log: string | undefined
}): ComposerModalData {
  return {
    ...(args.repoId ? { initialRepoId: args.repoId } : {}),
    initialEphemeralVmRecipeId: ORCA_CLOUD_RECIPE_ID,
    recovery: {
      note: buildCloudEnvironmentFixPrompt({
        lead: args.lead,
        focus: args.focus,
        ...(args.focus === 'install' ? { installScript: args.installScript } : {}),
        ...(args.log ? { log: args.log } : {})
      }),
      agent: null
    },
    telemetrySource: 'unknown'
  }
}
