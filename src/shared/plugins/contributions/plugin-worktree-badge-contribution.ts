import { z, type RefinementCtx } from 'zod'
import { safePluginDisplayText } from '../manifest/plugin-display-text'
import {
  pluginCommandIdSchema,
  pluginIdSchema,
  pluginRelativePathSchema
} from '../manifest/plugin-manifest-fields'
import { pluginFieldDoc, pluginPathFieldDoc } from '../manifest/plugin-schema-field-docs'
import { PLUGIN_PANEL_ICONS } from './plugin-panel-contribution'

/** First release that reads `contributes.worktreeBadges`. */
export const PLUGIN_WORKTREE_BADGES_SINCE = '1.4.256'
export const PLUGIN_WORKTREE_BADGE_LIMIT = 16
export const PLUGIN_WORKTREE_BADGE_PATH_LIMIT = 8
export const PLUGIN_WORKTREE_BADGE_COMMAND_LIMIT = 8
export const PLUGIN_WORKTREE_BADGE_SVG_MAX_BYTES = 32 * 1024
export const PLUGIN_WORKTREE_BADGE_MAX_SEARCH_DEPTH = 3
/** Bounds a subfolder search of a huge workspace, such as a game depot, to a few hundred reads. */
export const PLUGIN_WORKTREE_BADGE_MAX_SEARCHED_FOLDERS = 256

const SINCE = PLUGIN_WORKTREE_BADGES_SINCE

/** Whether a badge icon is the path of an `.svg` file rather than a panel icon name. */
export function isPluginWorktreeBadgeSvgIcon(icon: string): boolean {
  return /\.svg$/i.test(icon)
}

const badgeSvgIconSchema = pluginRelativePathSchema.regex(/\.svg$/i, 'must end in .svg')

export const pluginWorktreeBadgeContributionSchema = z
  .object({
    id: pluginIdSchema.meta(
      pluginFieldDoc("Badge id, unique among this plugin's worktree badges.", SINCE, [
        'unity-project'
      ])
    ),
    title: safePluginDisplayText(z.string().min(1).max(256)).meta(
      pluginFieldDoc('Tooltip, accessible name and menu heading of the badge.', SINCE, [
        'Unity project'
      ])
    ),
    icon: z
      .union([z.enum(PLUGIN_PANEL_ICONS), badgeSvgIconSchema])
      .meta(
        pluginPathFieldDoc(
          'A name from the panel icon set, or the path of a monochrome `.svg` (at most 32 KB) that Orca draws in the text color.',
          SINCE,
          ['package', 'icons/unity.svg']
        )
      ),
    when: z
      .object({
        pathExists: z
          .array(pluginRelativePathSchema)
          .min(1)
          .max(PLUGIN_WORKTREE_BADGE_PATH_LIMIT)
          .meta(
            pluginFieldDoc(
              `The badge shows when the workspace folder holds any of these paths, relative to the folder. At most ${PLUGIN_WORKTREE_BADGE_PATH_LIMIT}.`,
              SINCE,
              [['ProjectSettings/ProjectVersion.txt']]
            )
          ),
        searchDepth: z
          .number()
          .int()
          .min(0)
          .max(PLUGIN_WORKTREE_BADGE_MAX_SEARCH_DEPTH)
          .default(0)
          .meta(
            pluginFieldDoc(
              `Also look for \`pathExists\` in subfolders this many levels down, and list each folder that holds one; its commands then run on that folder. Hidden folders, \`node_modules\`, symbolic links and folders inside a match are skipped, and the search stops after ${PLUGIN_WORKTREE_BADGE_MAX_SEARCHED_FOLDERS} folders. Defaults to 0, the workspace folder only.`,
              SINCE,
              [2]
            )
          ),
        host: z
          .enum(['local', 'any'])
          .default('any')
          .meta(
            pluginFieldDoc(
              '`local` leaves out workspaces on SSH hosts, such as for commands that start a desktop app. Defaults to `any`.',
              SINCE
            )
          )
      })
      .strict()
      .meta(
        pluginFieldDoc('When Orca shows the badge. Orca checks it; the plugin is not asked.', SINCE)
      ),
    commands: z
      .array(pluginCommandIdSchema)
      .min(1)
      .max(PLUGIN_WORKTREE_BADGE_COMMAND_LIMIT)
      .meta(
        pluginFieldDoc(
          `Ids of this plugin's worker commands with \`when: "workspace"\`, offered from the badge and the workspace's context menu. At most ${PLUGIN_WORKTREE_BADGE_COMMAND_LIMIT}.`,
          SINCE,
          [['unity.open']]
        )
      )
  })
  .strict()
  .meta({
    id: 'WorktreeBadgeContribution',
    description:
      'An icon beside the name of each workspace whose folder holds a marker path; it opens a menu of workspace commands. Needs `workspace:read`, since a command run from it receives the folder.'
  })

export type PluginWorktreeBadgeContribution = z.infer<typeof pluginWorktreeBadgeContributionSchema>

export type PluginWorktreeBadgeIcon =
  | { kind: 'named'; name: string }
  | { kind: 'svg'; markup: string }

/** A badge as main projects it for clients; an SVG travels inline so clients never read plugin files. */
export type PluginWorktreeBadgeEntry = {
  id: string
  title: string
  icon: PluginWorktreeBadgeIcon
  when: { pathExists: string[]; searchDepth: number; host: 'local' | 'any' }
  commands: string[]
}

/** Checks what the schema cannot: unique badge ids, commands that are worker commands with
 *  `when: "workspace"`, and the `workspace:read` capability. */
export function validatePluginWorktreeBadges(
  manifest: {
    contributes: {
      commands: readonly { id: string; action?: string; when?: 'global' | 'workspace' }[]
      worktreeBadges: readonly { id: string; commands: readonly string[] }[]
    }
    capabilities: readonly { kind: string }[]
  },
  ctx: RefinementCtx
): void {
  const { commands, worktreeBadges } = manifest.contributes
  const ids = new Set<string>()
  const workerCommands = new Map(commands.map((command) => [command.id, command]))
  for (const [index, badge] of worktreeBadges.entries()) {
    if (ids.has(badge.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['contributes', 'worktreeBadges', index],
        message: `duplicate worktreeBadges id: ${badge.id}`
      })
    }
    ids.add(badge.id)
    for (const [commandIndex, commandId] of badge.commands.entries()) {
      const command = workerCommands.get(commandId)
      if (!command || command.action !== undefined || command.when !== 'workspace') {
        ctx.addIssue({
          code: 'custom',
          path: ['contributes', 'worktreeBadges', index, 'commands', commandIndex],
          message: `must name a contributed worker command with when "workspace": ${commandId}`
        })
      }
    }
  }
  if (
    worktreeBadges.length > 0 &&
    !manifest.capabilities.some((capability) => capability.kind === 'workspace:read')
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['contributes', 'worktreeBadges'],
      message: 'needs the "workspace:read" capability, since its commands receive the folder'
    })
  }
}
