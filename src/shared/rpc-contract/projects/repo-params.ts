import { WorkspaceHookSettingsSchema } from '../../workspace-setup/hooks/workspace-hook-settings-schema'
import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

// Opt-in: a caller holding afterSnapshotId's repos gets `unchanged`; older hosts take no params and ignore it.
export const RepoList = lazyZodSchema(() =>
  z.object({
    afterSnapshotId: z.string().min(1).max(128).nullable().optional()
  })
)
import {
  OptionalBoolean,
  OptionalFiniteNumber,
  OptionalString,
  requiredString
} from '../rpc-param-primitives'
import { createRepoUpdateSchema } from './repo-update-params'
import { RepoSelector, RepoShow } from '../github/github-repo-target-params'

export const RepoPath = lazyZodSchema(() =>
  z.object({
    path: requiredString('Missing repo path'),
    kind: z.enum(['git', 'folder']).optional(),
    displayName: OptionalString
  })
)

export const RepoCreate = lazyZodSchema(() =>
  z.object({
    parentPath: requiredString('Missing parent path'),
    name: requiredString('Missing repo name'),
    kind: z.enum(['git', 'folder']).optional()
  })
)

export const RepoClone = lazyZodSchema(() =>
  z.object({
    url: requiredString('Missing clone URL'),
    destination: requiredString('Missing clone destination'),
    folderName: z.string().optional()
  })
)

export const RepoSetBaseRef = lazyZodSchema(() =>
  z.object({
    repo: requiredString('Missing repo selector'),
    ref: requiredString('Missing base ref')
  })
)

export const RepoUpdate = createRepoUpdateSchema(RepoSelector.shape)

/** `repo.setHidden`: sidebar-only; `repoHostId` picks one host's copy of a repo id set up on several. */
export const RepoSetHidden = RepoShow.extend({
  hidden: z.boolean()
})

// Older hosts strip this and read the project checkout, as before.
const SetupHooksCreateSourceParam = lazyZodSchema(() =>
  z
    .union([
      z.object({ kind: z.literal('base'), baseBranch: z.string().optional() }),
      z.object({
        kind: z.literal('branch'),
        ref: z.string().min(1),
        baseBranch: z.string().optional()
      })
    ])
    .optional()
)

/** See `repoHooksCheckIsBackground`: only `wakeWslDistro` may open a stopped WSL distro (E9). */
export const RepoHooksCheck = RepoSelector.extend({
  background: z.boolean().optional(),
  wakeWslDistro: OptionalBoolean,
  createSource: SetupHooksCreateSourceParam
})

/** `repo.hooks`: `createSource` reports the setup a create from that ref would run. */
export const RepoHooksRead = RepoSelector.extend({
  createSource: SetupHooksCreateSourceParam
})

export const RepoSearchRefs = lazyZodSchema(() =>
  z.object({
    namespace: z.literal('remote').optional(),
    repo: requiredString('Missing repo selector'),
    query: z
      .unknown()
      .transform((v) => (typeof v === 'string' ? v : undefined))
      .pipe(z.string({ message: 'Missing query' })),
    limit: OptionalFiniteNumber
  })
)

export const RepoReorder = lazyZodSchema(() =>
  z.object({
    orderedIds: z.array(z.string())
  })
)

export const ProjectGroupCreate = lazyZodSchema(() =>
  z.object({
    name: requiredString('Missing group name'),
    parentPath: OptionalString,
    connectionId: OptionalString.nullable().optional(),
    parentGroupId: OptionalString.nullable().optional(),
    createdFrom: z.enum(['manual', 'folder-scan', 'migration']).optional()
  })
)

export const ProjectGroupUpdate = lazyZodSchema(() =>
  z.object({
    groupId: requiredString('Missing group id'),
    updates: z.object({
      hookSettings: WorkspaceHookSettingsSchema.optional(),
      name: OptionalString,
      isCollapsed: z.boolean().optional(),
      tabOrder: OptionalFiniteNumber,
      rootProjectOrder: z.number().finite().nullable().optional(),
      color: OptionalString.nullable().optional()
    })
  })
)

export const ProjectGroupSelector = lazyZodSchema(() =>
  z.object({
    groupId: requiredString('Missing group id')
  })
)

export const ProjectGroupHooksCheck = lazyZodSchema(() =>
  ProjectGroupSelector.extend({
    background: z.boolean().optional()
  })
)

export const ProjectGroupUpdateMany = lazyZodSchema(() =>
  z.object({
    mutations: z.array(ProjectGroupUpdate)
  })
)

// Why `connectionId` is optional: older clients omit it, and older hosts strip it (bare selector).
export const ProjectGroupMoveProject = lazyZodSchema(() =>
  z.object({
    repo: requiredString('Missing repo selector'),
    groupId: OptionalString.nullable(),
    order: OptionalFiniteNumber,
    connectionId: z.string().nullable().optional()
  })
)

export const ProjectGroupScanNested = lazyZodSchema(() =>
  z.object({
    path: requiredString('Missing folder path')
  })
)

export const ProjectGroupImportNested = lazyZodSchema(() =>
  z.discriminatedUnion('mode', [
    z.object({
      parentPath: requiredString('Missing parent path'),
      groupName: z.string().optional().default(''),
      projectPaths: z.array(z.string()),
      mode: z.literal('group')
    }),
    z.object({
      parentPath: requiredString('Missing parent path'),
      // Blank group names use the scanned folder basename; separate imports share the payload but create no group.
      groupName: z.string().optional().default(''),
      projectPaths: z.array(z.string()),
      mode: z.literal('separate')
    })
  ])
)

/** `wakeWslDistro`: the user saving their own edit, which may start a stopped WSL distro; older hosts drop it. */
export const RepoIssueCommandWrite = RepoSelector.extend({
  content: z.string(),
  wakeWslDistro: OptionalBoolean
})

export const RepoSparsePresetSave = RepoSelector.extend({
  id: OptionalString,
  name: requiredString('Missing preset name'),
  directories: z.array(z.string())
})

export const RepoSparsePresetRemove = RepoSelector.extend({
  presetId: requiredString('Missing preset id')
})
