/**
 * The drift gate for tests/e2e/orchestration-guide-contract.spec.ts.
 *
 * The spec records every `orchestration` argv it runs through the compiled CLI;
 * this compares that record against the commands the skill guide actually
 * teaches. Both directions fail the test:
 *
 *   - a guide command nobody executed is either newly documented and unproven,
 *     or the spec stopped covering it — unless it is excused below;
 *   - a flag the spec executed that no guide file documents means the taught
 *     path and the tested path have diverged.
 *
 * Excuses are per (verb, flag) and each carries the reason it cannot be reached
 * from one local profile. They are still covered by the static contract test in
 * config/scripts/orchestration-guide-command-contract.test.mjs, which proves the
 * CLI specs still accept them.
 */
import {
  commandPair,
  documentedOrchestrationCommandPairs
} from '../../../config/scripts/orchestration-guide-invocations'

export type GuideCoverageGaps = {
  /** Documented by the guide, never executed, and not excused. */
  unexecuted: string[]
  /** Executed by the spec, documented by no guide file, and not excused. */
  undocumented: string[]
}

type Excuse = { pairs: string[]; reason: string }

const NOT_EXECUTED: Excuse[] = [
  {
    pairs: ['worker-start --on', 'worker-start --repo', 'worker-start --setup'],
    reason:
      'Remote placement needs a second execution host and a repo selector on it; this spec owns one local profile.'
  },
  {
    pairs: ['worker-start --name', 'worker-start --retry-of', 'worker-start --terminal'],
    reason:
      'Each needs state this spec deliberately never reaches: a new worktree to name, a positively-proven failed Dispatch to retry, and an idle pre-existing agent terminal to adopt.'
  },
  {
    pairs: ['worker-start --model', 'worker-start --effort'],
    reason:
      'Launch preferences are forwarded only when the worker server advertises support, and the fake agent on PATH takes no model argv, so executing them would assert nothing.'
  },
  {
    pairs: ['run-use --takeover-legacy'],
    reason:
      'Takeover fences a live legacy coordinator. Reaching it needs a pre-cutover database; src/main/runtime/orchestration/orchestration-adopted-run-binding.test.ts builds that graph directly.'
  },
  {
    pairs: ['worker-abandon --dispatch', 'worker-abandon --json'],
    reason:
      'Abandon fences a Dispatch whose resources may still be live; tests/e2e/orchestration-low-level-dispatch-release.spec.ts already drives it against a live runtime.'
  }
]

const NOT_DOCUMENTED: Excuse[] = [
  {
    pairs: ['ask --json'],
    reason:
      'The guide prints `ask` without `--json` because a worker reads the answer as prose; the spec needs the machine-readable receipt to assert the pending question id and the resumed answer.'
  }
]

function expandExcuses(excuses: Excuse[]): Map<string, string> {
  const byPair = new Map<string, string>()
  for (const excuse of excuses) {
    for (const pair of excuse.pairs) {
      byPair.set(pair, excuse.reason)
    }
  }
  return byPair
}

export type GuideCommandLedger = {
  /** `args` is the full CLI argv, e.g. ['orchestration', 'send', '--to', ...]. */
  record: (args: string[]) => void
  executedPairs: () => Set<string>
}

export function createGuideCommandLedger(): GuideCommandLedger {
  const executed = new Set<string>()
  return {
    record: (args) => {
      if (args[0] !== 'orchestration' || !args[1]) {
        return
      }
      const verb = args[1]
      for (const arg of args.slice(2)) {
        if (arg.startsWith('--')) {
          executed.add(commandPair(verb, arg.slice(2)))
        }
      }
    },
    executedPairs: () => new Set(executed)
  }
}

export function findGuideCoverageGaps(
  executed: Set<string>,
  projectDir?: string
): GuideCoverageGaps {
  const documented = documentedOrchestrationCommandPairs(projectDir)
  const excusedUnexecuted = expandExcuses(NOT_EXECUTED)
  const excusedUndocumented = expandExcuses(NOT_DOCUMENTED)
  return {
    unexecuted: [...documented]
      .filter((pair) => !executed.has(pair) && !excusedUnexecuted.has(pair))
      .sort(),
    undocumented: [...executed]
      .filter((pair) => !documented.has(pair) && !excusedUndocumented.has(pair))
      .sort()
  }
}

/**
 * An excuse that no longer excuses anything is itself drift: a not-executed entry
 * for a command the guide dropped, or a not-documented entry for one it adopted.
 */
export function findStaleExcuses(projectDir?: string): string[] {
  const documented = documentedOrchestrationCommandPairs(projectDir)
  return [
    ...[...expandExcuses(NOT_EXECUTED).keys()].filter((pair) => !documented.has(pair)),
    ...[...expandExcuses(NOT_DOCUMENTED).keys()].filter((pair) => documented.has(pair))
  ].sort()
}
