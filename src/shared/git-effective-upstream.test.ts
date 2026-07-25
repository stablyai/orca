import { describe, expect, it } from 'vitest'
import { resolveEffectiveGitUpstream } from './git-effective-upstream'

const NON_ASCII_BRANCH = 'egoing/AGENTS.md-를-생성하고-위키-정책을-수립하기'

function ambiguousHeadUpstreamError(): Error {
  return new Error(
    "fatal: ambiguous argument 'HEAD@{u}': unknown revision or path not in the working tree."
  )
}

describe('resolveEffectiveGitUpstream', () => {
  it('resolves the upstream for a non-ASCII branch name that git truncates under --short/--abbrev-ref', async () => {
    const runGit = async (args: string[]): Promise<{ stdout: string }> => {
      if (args[0] === 'symbolic-ref') {
        // Full ref form must not be truncated the way `--short` is for this branch name.
        return { stdout: `refs/heads/${NON_ASCII_BRANCH}\n` }
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        // Reproduces git's real behavior for this branch: @{u} resolution fails outright.
        throw ambiguousHeadUpstreamError()
      }
      if (args[0] === 'config') {
        const key = args.at(-1)
        if (key === `branch.${NON_ASCII_BRANCH}.remote`) {
          return { stdout: 'origin\n' }
        }
        if (key === `branch.${NON_ASCII_BRANCH}.merge`) {
          return { stdout: `refs/heads/${NON_ASCII_BRANCH}\n` }
        }
        if (key === `branch.${NON_ASCII_BRANCH}.base`) {
          throw new Error('fatal: key not found')
        }
      }
      if (
        args[0] === 'rev-parse' &&
        args.includes('--verify') &&
        args.at(-1) === `refs/remotes/origin/${NON_ASCII_BRANCH}`
      ) {
        return { stdout: `deadbeef${NON_ASCII_BRANCH}\n` }
      }
      throw new Error(`unexpected git invocation: ${JSON.stringify(args)}`)
    }

    const upstream = await resolveEffectiveGitUpstream(runGit)

    expect(upstream).toEqual({
      upstreamName: `origin/${NON_ASCII_BRANCH}`,
      remoteName: 'origin',
      branchName: NON_ASCII_BRANCH,
      isConfiguredUpstream: false
    })
  })
})
