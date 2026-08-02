import { accessSync, constants as fsConstants, existsSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'
import type {
  EphemeralVmRecipeDoctorCheck,
  EphemeralVmRecipeDoctorResult
} from './ephemeral-vm-recipes'
import type { OrcaVmRecipe } from './types'

export function doctorEphemeralVmRecipe(args: {
  repoPath: string
  recipeId: string
  recipes: readonly OrcaVmRecipe[]
  localExecutionSupported?: boolean
}): EphemeralVmRecipeDoctorResult {
  const checks: EphemeralVmRecipeDoctorCheck[] = []
  if (!args.localExecutionSupported) {
    checks.push({
      id: 'recipe.execution_target',
      status: 'fail',
      message: 'Ephemeral VM recipes run on the local desktop host in v1.',
      remediation: 'Use a local repo checkout for the recipe, or add remote recipe execution later.'
    })
    return buildDoctorResult(args.recipeId, args.repoPath, checks)
  }
  if (!existsSync(args.repoPath) || !statSync(args.repoPath).isDirectory()) {
    checks.push({
      id: 'repo.path',
      status: 'fail',
      message: `Repo path does not exist or is not a directory: ${args.repoPath}`,
      remediation: 'Pass the local repo that contains orca.yaml.'
    })
    return buildDoctorResult(args.recipeId, args.repoPath, checks)
  }

  const recipe = args.recipes.find((entry) => entry.id === args.recipeId)
  checks.push({
    id: 'recipe.exists',
    status: recipe ? 'pass' : 'fail',
    message: recipe
      ? `Found recipe "${recipe.name}".`
      : `Recipe "${args.recipeId}" was not found in environmentRecipes.`,
    ...(recipe ? {} : { remediation: 'Check the recipe id or add it to environmentRecipes.' })
  })
  if (!recipe) {
    return buildDoctorResult(args.recipeId, args.repoPath, checks)
  }

  checks.push(checkCommandPath(args.repoPath, recipe.create, 'recipe.create'))
  if (recipe.destroyDisabled) {
    checks.push({
      id: 'recipe.destroy',
      status: 'warn',
      message: 'Destroy is explicitly disabled.',
      remediation: 'Only use destroy: none when provider resources are cleaned up elsewhere.'
    })
  } else if (recipe.destroy) {
    checks.push(checkCommandPath(args.repoPath, recipe.destroy, 'recipe.destroy'))
  } else {
    checks.push({
      id: 'recipe.destroy',
      status: 'warn',
      message: 'No destroy action is configured.',
      remediation: 'Add destroy or explicitly set destroy: none.'
    })
  }

  if (recipe.suspend) {
    checks.push(checkCommandPath(args.repoPath, recipe.suspend, 'recipe.suspend'))
  }
  if (recipe.resume) {
    checks.push(checkCommandPath(args.repoPath, recipe.resume, 'recipe.resume'))
  }
  // Why: a workspace suspended by `suspend` can only be woken if `resume` exists;
  // defining one without the other strands the workspace asleep.
  if (Boolean(recipe.suspend) !== Boolean(recipe.resume)) {
    checks.push({
      id: 'recipe.suspend_resume_pairing',
      status: 'warn',
      message: 'Recipe defines only one of suspend/resume.',
      remediation: 'Define both so a suspended workspace can be resumed, or neither.'
    })
  }

  return buildDoctorResult(args.recipeId, args.repoPath, checks)
}

export function firstRecipeCommandToken(command: string): string | null {
  const trimmed = command.trim()
  if (!trimmed) {
    return null
  }
  const quoted = trimmed.match(/^"([^"]+)"/) ?? trimmed.match(/^'([^']+)'/)
  if (quoted) {
    return quoted[1] ?? null
  }
  return trimmed.split(/\s+/)[0] ?? null
}

function checkCommandPath(
  repoPath: string,
  command: string,
  id: string
): EphemeralVmRecipeDoctorCheck {
  const executable = firstRecipeCommandToken(command)
  if (!executable) {
    return {
      id,
      status: 'fail',
      message: 'Command is empty.',
      remediation: 'Set a repo-relative command path.'
    }
  }
  if (isAbsolute(executable)) {
    return {
      id,
      status: 'warn',
      message: `Command uses an absolute path: ${executable}`,
      remediation: 'Prefer a repo-relative script so the recipe works across machines.'
    }
  }
  if (!executable.startsWith('./') && !executable.startsWith('.\\')) {
    return {
      id,
      status: 'warn',
      message: `Command is not a repo-relative path: ${executable}`,
      remediation: 'Use a repo-relative script such as ./scripts/orca-vm/start.sh.'
    }
  }
  const scriptPath = join(repoPath, normalize(executable))
  if (!existsSync(scriptPath)) {
    return {
      id,
      status: 'fail',
      message: `Command path does not exist: ${executable}`,
      remediation: 'Create the script or update the recipe command path.'
    }
  }
  // Why: a non-executable script fails create with a confusing EACCES. The exec
  // bit is a POSIX concept — skip on Windows, where it does not apply.
  if (process.platform !== 'win32') {
    try {
      accessSync(scriptPath, fsConstants.X_OK)
    } catch {
      return {
        id,
        status: 'warn',
        message: `Command exists but is not executable: ${executable}`,
        remediation: 'Make it executable: chmod +x (git: git update-index --chmod=+x).'
      }
    }
  }
  return {
    id,
    status: 'pass',
    message: `Command path exists: ${executable}`
  }
}

function buildDoctorResult(
  recipeId: string,
  repoPath: string,
  checks: EphemeralVmRecipeDoctorCheck[]
): EphemeralVmRecipeDoctorResult {
  return {
    recipeId,
    repoPath,
    ok: checks.every((check) => check.status !== 'fail'),
    checks
  }
}
