import { translate } from '@/i18n/i18n'
import type { WorktreeCardPrDisplay } from '../../worktree-card-pr-display'
import {
  previewFacts,
  type CardPreviewAgent,
  type CardPreviewScenario
} from './card-preview-scenario'

// Sample copy a person reads in the gallery; agent names are product names.
function sample(key: string, fallback: string): string {
  return translate(`auto.components.cardStudio.sample.${key}`, fallback)
}

function agents(): Record<'working' | 'blocked' | 'done', CardPreviewAgent> {
  return {
    working: {
      title: CLAUDE,
      state: 'working',
      message: sample('working', 'Rebuilding the card template compiler'),
      ago: '2m',
      agoMs: 2 * 60_000
    },
    blocked: {
      title: CODEX,
      state: 'blocked',
      message: sample('blocked', 'Allow running pnpm test?'),
      ago: '1m',
      agoMs: 60_000
    },
    done: {
      title: CLAUDE,
      state: 'done',
      message: sample('done', 'Opened the PR'),
      ago: '12m',
      agoMs: 12 * 60_000
    }
  }
}

const CLAUDE = 'Claude'
const CODEX = 'Codex'

function review(
  state: 'open' | 'merged',
  status: 'success' | 'failure' | 'pending'
): WorktreeCardPrDisplay {
  return {
    provider: 'github',
    number: 4182,
    title: sample('reviewTitle', 'Draw workspace cards from a template'),
    state,
    status,
    url: 'https://github.com/example/orca/pull/4182'
  }
}

type ScenarioInput = Partial<Omit<CardPreviewScenario, 'id' | 'title' | 'facts'>> & {
  facts?: Parameters<typeof previewFacts>[0]
}

function activityFacts(
  agents: readonly CardPreviewAgent[],
  status: string
): CardPreviewScenario['facts']['activity'] {
  const now = Date.now()
  const count = (state: CardPreviewAgent['state']) =>
    agents.filter((agent) => agent.state === state).length
  return {
    status,
    needsInput: status === 'permission',
    counts: {
      working: count('working'),
      blocked: count('blocked'),
      done: count('done'),
      idle: count('idle')
    },
    agents: agents.map((agent) => ({
      title: agent.title,
      agent: agent.title.toLowerCase(),
      state: agent.state,
      message: agent.message,
      since: now - agent.agoMs
    }))
  }
}

function scenario(id: string, title: string, input: ScenarioInput): CardPreviewScenario {
  const prDisplay = input.review ?? null
  return {
    id,
    title,
    status: input.status ?? 'inactive',
    isSleeping: input.isSleeping ?? false,
    agents: input.agents ?? [],
    review: prDisplay,
    issue: input.issue ?? null,
    sshStatus: input.sshStatus ?? null,
    detachedHead: input.detachedHead ?? null,
    repoColor: input.repoColor ?? '#7c3aed',
    facts: previewFacts({
      ...input.facts,
      activity: activityFacts(input.agents ?? [], input.status ?? 'inactive'),
      ...(prDisplay
        ? {
            review: {
              title: prDisplay.title,
              state: prDisplay.state ?? 'open',
              status: prDisplay.status ?? null
            }
          }
        : {})
    })
  }
}

/** The states the Card Studio's gallery always shows, like a component library's stories. */
export function cardPreviewScenarios(): CardPreviewScenario[] {
  const { working, blocked, done } = agents()
  const t = (key: string, fallback: string): string =>
    translate(`auto.components.cardStudio.scenario.${key}`, fallback)
  return [
    scenario('working', t('working', 'Agent working'), { status: 'working', agents: [working] }),
    scenario('blocked', t('blocked', 'Needs input'), {
      status: 'permission',
      agents: [blocked],
      facts: { ws: { isUnread: true } }
    }),
    scenario('done', t('done', 'Agent done'), { status: 'done', agents: [done] }),
    scenario('prOpen', t('prOpen', 'Pull request open'), {
      status: 'active',
      review: review('open', 'pending'),
      facts: { links: { count: 1 } }
    }),
    scenario('prFailing', t('prFailing', 'Checks failing'), {
      status: 'active',
      review: review('open', 'failure'),
      facts: { links: { count: 1 }, checks: { total: 6, passing: 4, failing: 2, pending: 0 } }
    }),
    scenario('prMerged', t('prMerged', 'Merged'), {
      status: 'done',
      review: review('merged', 'success'),
      facts: { links: { count: 1 } }
    }),
    scenario('conflicts', t('conflicts', 'Merge conflicts'), {
      status: 'active',
      review: review('open', 'failure'),
      facts: {
        git: {
          conflictOperation: 'merge',
          remoteBranchConflict: { remote: 'origin', branch: 'feature/card-plugins' }
        }
      }
    }),
    scenario('folder', t('folder', 'Folder workspace'), {
      facts: {
        ws: {
          kind: 'folder',
          branch: '',
          identity: null,
          name: 'notes',
          title: 'notes',
          path: '/work/notes'
        },
        repo: { name: 'notes' }
      }
    }),
    scenario('sshDisconnected', t('sshDisconnected', 'SSH disconnected'), {
      sshStatus: 'disconnected',
      facts: { repo: { ssh: true }, host: { kind: 'ssh' } }
    }),
    scenario('compact', t('compact', 'Compact'), {
      status: 'working',
      agents: [working],
      review: review('open', 'success'),
      facts: { options: { style: 'compact' }, ws: { isMain: true }, links: { count: 1 } }
    }),
    scenario('longNames', t('longNames', 'Long names'), {
      status: 'active',
      facts: {
        ws: {
          name: 'investigate-intermittent-renderer-compositor-stall-on-windows',
          title: 'investigate-intermittent-renderer-compositor-stall-on-windows',
          branch: 'nwparker/investigate-intermittent-renderer-compositor-stall-on-windows-arm64',
          identity: 'nwparker/investigate-intermittent-renderer-compositor-stall-on-windows-arm64'
        },
        repo: { name: 'orca-desktop-monorepo-with-a-long-name' }
      }
    }),
    scenario('detached', t('detached', 'Detached HEAD'), {
      facts: { ws: { branch: '', identity: null, detachedHead: true } },
      detachedHead: {
        kind: 'detached',
        shortHead: 'a1b2c3d',
        sidebarLabel: 'Detached HEAD @ a1b2c3d',
        sourceControlLabel: 'a1b2c3d',
        tooltip: sample('detachedTooltip', 'Detached HEAD at a1b2c3d.')
      }
    })
  ]
}
