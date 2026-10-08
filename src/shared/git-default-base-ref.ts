import { iterateProcessOutputLines } from './process-output-field-scanner'

export const DEFAULT_BASE_REF_PROBES: readonly { ref: string; returnAs: string }[] = [
  { ref: 'refs/remotes/origin/main', returnAs: 'origin/main' },
  { ref: 'refs/remotes/origin/master', returnAs: 'origin/master' },
  { ref: 'refs/heads/main', returnAs: 'main' },
  { ref: 'refs/heads/master', returnAs: 'master' }
]

export type GitExec = (argv: string[]) => Promise<{ stdout: string }>

/** Resolve the same default-base ordering through a host-owned Git executor. */
export async function resolveDefaultBaseRefViaExec(exec: GitExec): Promise<string | null> {
  const originHeadRef = 'refs/remotes/origin/HEAD'
  const refs = [originHeadRef, ...DEFAULT_BASE_REF_PROBES.map(({ ref }) => ref)]
  // A character class forces exact matching instead of including descendants such as main/topic.
  const patterns = refs.map((ref) => `${ref.slice(0, -1)}[${ref.slice(-1)}]`)
  try {
    const { stdout } = await exec(['for-each-ref', '--format=%(refname)%00%(symref)', ...patterns])
    const presentRefs = new Set<string>()
    for (const line of iterateProcessOutputLines(stdout)) {
      const separator = line.indexOf('\0')
      if (separator === -1) {
        continue
      }
      const ref = line.slice(0, separator)
      const target = line.slice(separator + 1)
      if (ref === originHeadRef && target) {
        return target.replace(/^refs\/remotes\//, '')
      }
      presentRefs.add(ref)
    }
    return DEFAULT_BASE_REF_PROBES.find(({ ref }) => presentRefs.has(ref))?.returnAs ?? null
  } catch {
    return null
  }
}
