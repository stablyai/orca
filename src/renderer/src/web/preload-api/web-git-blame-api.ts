import type { GitInspectionApi } from '../../../../preload/api/git-inspection-api'
import type { GitBlameResult } from '../../../../shared/git-blame'
import { callAbortableRuntimeEnvironment } from '../../runtime/abortable-runtime-environment-call'
import { toRuntimeWorktreeSelector } from '../../runtime/runtime-worktree-selector'
import { callRuntimeResult } from './web-runtime-calls'
import { requireActiveEnvironment, updateEnvironmentFromResponse } from './web-runtime-session'
import { resolveRuntimeWorktreeByPath } from './web-runtime-worktree-catalog'

const abortControllers = new Map<string, AbortController>()

export const webGitBlameApi: Pick<GitInspectionApi, 'blame' | 'cancelBlame'> = {
	blame: async ({ worktreePath, relativePath, requestToken }) => {
		const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
		const params = { worktree: toRuntimeWorktreeSelector(worktree.id), relativePath }
		if (!requestToken) {
			return callRuntimeResult<GitBlameResult>('git.blame', params)
		}
		const environment = requireActiveEnvironment()
		abortControllers.get(requestToken)?.abort()
		const controller = new AbortController()
		abortControllers.set(requestToken, controller)
		try {
			const response = await callAbortableRuntimeEnvironment(
				environment.id,
				'git.blame',
				params,
				undefined,
				controller.signal
			)
			updateEnvironmentFromResponse(environment, response)
			if (!response.ok) {
				throw new Error(response.error.message)
			}
			return response.result as GitBlameResult
		} finally {
			if (abortControllers.get(requestToken) === controller) {
				abortControllers.delete(requestToken)
			}
		}
	},
	cancelBlame: async ({ requestToken }) => {
		abortControllers.get(requestToken)?.abort()
	}
}
