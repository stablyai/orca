// Orca Cloud's part of the composer's recipe options: the setup entry offered before the account
// is ready, carrying a picked Orca Cloud across project changes, and the rollout flag.
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { ORCA_CLOUD_RECIPE_ID } from '../../../shared/hosted-sandbox/orca-cloud-recipe-id'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host/execution-host'
import type {
  OrcaCloudAvailability,
  OrcaVmRecipe
} from '../../../shared/workspace-setup/orca-yaml-hook-types'
import { useAppStore } from '@/store'
import { useOrcaCloudEnabled } from '@/hooks/useOrcaCloudEnabled'

/** Orca Cloud is shipped but the account isn't ready yet (signed out, or no plan/capability). */
function orcaCloudNeedsSetup(availability: OrcaCloudAvailability | undefined): boolean {
  return availability === 'needs-sign-in' || availability === 'needs-capability'
}

/**
 * Main lists the Orca Cloud recipe only once the account can use it. Until then the composer still
 * offers it, so a signed-out or not-yet-entitled user can pick Orca Cloud and reach "Set up and
 * start"; the setup panel runs instead of a create, so this entry never starts a VM.
 */
const ORCA_CLOUD_SETUP_RECIPE: OrcaVmRecipe = {
  id: ORCA_CLOUD_RECIPE_ID,
  name: 'Orca Cloud',
  provider: 'orca-cloud',
  create: 'orca-cloud create'
}

function isOrcaCloudOption(recipe: OrcaVmRecipe): boolean {
  return recipe.id === ORCA_CLOUD_RECIPE_ID || recipe.provider === 'orca-cloud'
}

export function withOrcaCloudSetupRecipe(
  recipes: OrcaVmRecipe[],
  availability: OrcaCloudAvailability | undefined,
  /** A plain folder: main lists no recipes for it, but Orca Cloud is still offered. */
  folder = false
): OrcaVmRecipe[] {
  const offeredForFolder = folder && availability === 'offered'
  if (
    !(orcaCloudNeedsSetup(availability) || offeredForFolder) ||
    recipes.some((r) => r.id === ORCA_CLOUD_RECIPE_ID)
  ) {
    return recipes
  }
  return [ORCA_CLOUD_SETUP_RECIPE, ...recipes]
}

/**
 * Why a picked Orca Cloud didn't carry over to a newly picked project. `elsewhere`:
 * the project lives on another machine (SSH or a remote server's own target) or is a project group;
 * `unreachable`: Orca Cloud didn't answer; `unavailable`: it isn't offered for this project.
 */
export type OrcaCloudDropReason = 'elsewhere' | 'unreachable' | 'unavailable'

/** Fields the composer reads beside the recipe list. */
export type OrcaCloudRecipeOptions = {
  /** Recipes may be picked: custom recipes are on, or the list holds Orca Cloud (all a flag-off list can hold). */
  offered: boolean
  /** Orca Cloud for this target as main reports it; `unavailable` where recipe VMs can't run. */
  orcaCloud: OrcaCloudAvailability
  /** Set when a project change had to drop a picked Orca Cloud; cleared by the next pick. */
  orcaCloudDropped: OrcaCloudDropReason | null
}

/**
 * A plain folder still loads: it offers Orca Cloud only, and the setup panel then says the
 * project needs a GitHub repository instead of the option vanishing. A project cloned only on a
 * remote Orca server (a paired cloud workspace's) still offers Orca Cloud; like a folder it has no
 * recipes here and starts from GitHub.
 */
export function isRemoteServerRepo(
  repoConnectionId: string | null,
  repoExecutionHostId: ExecutionHostId | null
): boolean {
  return !repoConnectionId && parseExecutionHostId(repoExecutionHostId)?.kind === 'runtime'
}

type ListedRecipesScope = {
  customRecipesEnabled: boolean
  repoIsGit: boolean
  remoteServer: boolean
}

/** Orca Cloud rides its account capability, not the experimental VM-recipes flag. */
export function offeredRecipes(
  listed: OrcaVmRecipe[] | undefined,
  orcaCloud: OrcaCloudAvailability | undefined,
  scope: ListedRecipesScope
): OrcaVmRecipe[] {
  return withOrcaCloudSetupRecipe(
    scope.remoteServer
      ? []
      : (listed ?? []).filter(
          (recipe) =>
            recipe.provider === 'orca-cloud' || (scope.customRecipesEnabled && scope.repoIsGit)
        ),
    orcaCloud,
    !scope.repoIsGit || scope.remoteServer
  )
}

/** orca.yaml recipe diagnostics show only where custom recipes can be picked. */
export function showsRecipeDiagnostics(scope: ListedRecipesScope): boolean {
  return scope.customRecipesEnabled && scope.repoIsGit && !scope.remoteServer
}

export function orcaCloudDropReasonAfterLoad(
  orcaCloud: OrcaCloudAvailability | undefined,
  remoteServer: boolean
): OrcaCloudDropReason {
  return orcaCloud === 'unreachable' ? 'unreachable' : remoteServer ? 'elsewhere' : 'unavailable'
}

/** Orca Cloud's state beside the pick: main's availability, the last pick, and why it dropped. */
export function useOrcaCloudRecipeState(
  selectedRecipeId: string | null,
  setSelectedRecipeId: (recipeId: string | null) => void
): {
  orcaCloud: OrcaCloudAvailability
  setOrcaCloud: (availability: OrcaCloudAvailability) => void
  orcaCloudDropped: OrcaCloudDropReason | null
  setOrcaCloudDropped: (reason: OrcaCloudDropReason | null) => void
  selectedRef: RefObject<string | null>
  pickRecipe: (recipeId: string | null) => void
} {
  const [orcaCloudDropped, setOrcaCloudDropped] = useState<OrcaCloudDropReason | null>(null)
  const [orcaCloud, setOrcaCloud] = useState<OrcaCloudAvailability>('unavailable')
  // The pick as of the last render: a project change carries Orca Cloud over.
  const selectedRef = useRef<string | null>(null)
  // Called before the load effect, so a project change's load sees the pick it replaces.
  useEffect(() => {
    selectedRef.current = selectedRecipeId
  }, [selectedRecipeId])
  const pickRecipe = useCallback(
    (recipeId: string | null) => {
      setOrcaCloudDropped(null)
      setSelectedRecipeId(recipeId)
    },
    [setSelectedRecipeId]
  )
  return { orcaCloud, setOrcaCloud, orcaCloudDropped, setOrcaCloudDropped, selectedRef, pickRecipe }
}

/** Signing in or out, or a capability change, adds or drops the Orca Cloud recipe in main. */
export function useReloadOnOrcaCloudAuthChange(load: (resetSelection: boolean) => void): void {
  const authKey = useAppStore((state) => {
    const status = state.orcaProfileAuthStatus
    return `${status?.state ?? 'none'}:${status?.capabilities?.flags.sandbox === true}`
  })
  const lastAuthKey = useRef(authKey)
  useEffect(() => {
    if (lastAuthKey.current === authKey) {
      return
    }
    lastAuthKey.current = authKey
    load(false)
  }, [authKey, load])
}

/** The rollout flag hides "Run on: Orca Cloud" (and its sign-in and setup rows) entirely. */
export function useOrcaCloudRecipeView(args: {
  recipes: OrcaVmRecipe[]
  selectedRecipeId: string | null
  orcaCloud: OrcaCloudAvailability
  orcaCloudDropped: OrcaCloudDropReason | null
  canLoad: boolean
  customRecipesEnabled: boolean
  repoIsGit: boolean
}): { recipes: OrcaVmRecipe[]; selectedRecipeId: string | null } & OrcaCloudRecipeOptions {
  const cloudEnabled = useOrcaCloudEnabled()
  const { recipes } = args
  const visibleRecipes = useMemo(
    () => (cloudEnabled ? recipes : recipes.filter((recipe) => !isOrcaCloudOption(recipe))),
    [cloudEnabled, recipes]
  )
  return {
    recipes: visibleRecipes,
    selectedRecipeId:
      !cloudEnabled && args.selectedRecipeId === ORCA_CLOUD_RECIPE_ID
        ? null
        : args.selectedRecipeId,
    offered: (args.customRecipesEnabled && args.repoIsGit) || visibleRecipes.length > 0,
    orcaCloud: args.canLoad && cloudEnabled ? args.orcaCloud : 'unavailable',
    orcaCloudDropped: cloudEnabled ? args.orcaCloudDropped : null
  }
}
