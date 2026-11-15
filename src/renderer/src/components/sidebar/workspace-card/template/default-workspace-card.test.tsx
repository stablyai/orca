// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CardTemplateNode } from '../../../../../../shared/workspace-cards/card-template-schema'
import type {
  WorkspaceCardFacts,
  WorkspaceCardStyle
} from '../../../../../../shared/workspace-cards/workspace-card-facts'
import { CARD_PRIMITIVES } from './card-primitives'
import { cardElement, compileCardTemplate, type CardElement } from './card-template-compiler'
import { DEFAULT_WORKSPACE_CARD_TEMPLATE } from './default-workspace-card'

// Why stubs: Orca's real parts read the store; layout only needs to know where each part lands.
function stubParts(): Record<string, CardElement<null>> {
  const propsByPart = new Map<string, Set<string>>()
  const defs = DEFAULT_WORKSPACE_CARD_TEMPLATE.defs ?? {}
  const visit = (node: CardTemplateNode): void => {
    if (!Object.hasOwn(CARD_PRIMITIVES, node.el) && !Object.hasOwn(defs, node.el)) {
      const props = propsByPart.get(node.el) ?? new Set<string>()
      Object.keys(node.props ?? {}).forEach((prop) => props.add(prop))
      propsByPart.set(node.el, props)
    }
    node.children?.forEach(visit)
  }
  visit(DEFAULT_WORKSPACE_CARD_TEMPLATE.root)
  Object.values(defs).forEach(visit)
  return Object.fromEntries(
    [...propsByPart].map(([name, props]) => [
      name,
      cardElement<null>([...props], (_props, children) => <span data-part={name}>{children}</span>)
    ])
  )
}

const compiled = compileCardTemplate(DEFAULT_WORKSPACE_CARD_TEMPLATE, {
  ...CARD_PRIMITIVES,
  ...stubParts()
})

type FactsInput = {
  style: WorkspaceCardStyle
  detailsRow?: boolean
  branch?: boolean
}

function facts({ style, detailsRow = true, branch = false }: FactsInput): WorkspaceCardFacts {
  return {
    ws: {
      id: 'wt-1',
      name: 'session-prune-deleted',
      title: 'session-prune-deleted',
      kind: 'git',
      path: '/repo/session-prune-deleted',
      branch: 'session-prune-deleted',
      identity: 'session-prune-deleted',
      isMain: false,
      isSparse: false,
      detachedHead: false,
      isPinned: false,
      isUnread: false,
      isDeleting: false,
      isRenaming: false,
      hasRenameError: false,
      removalError: null,
      comment: ''
    },
    repo: null,
    host: { kind: 'local', contextLabel: null, runtimeDisconnected: false },
    git: { conflictOperation: null, remoteBranchConflict: null, cacheTimerActive: false },
    review: null,
    checks: { total: 0, passing: 0, failing: 0, pending: 0 },
    // A linked item is what draws the link / doc icons.
    links: { count: 1, issue: false, linearIssue: false, jiraIssue: false },
    provenance: { automation: false, cli: false },
    ports: { count: 0 },
    lineage: { childCount: 0, collapsed: false, toggleable: false },
    place: {
      isActive: false,
      inPinnedSection: false,
      hideRepoBadge: true,
      showProjectName: false,
      affiliateList: false,
      deleteQuickAction: false
    },
    options: {
      style,
      show: {
        status: true,
        unread: true,
        ci: true,
        branch,
        issue: true,
        linearIssue: true,
        jiraIssue: true,
        pr: true,
        automation: true,
        cli: true,
        comment: true,
        ports: true,
        inlineAgents: false,
        host: true
      },
      detailsRow,
      agentRows: 'full'
    },
    env: { projectGroups: false }
  }
}

function layout(input: FactsInput): {
  metaRow: Element | null
  indicators: Element | null
  singleLine: boolean
} {
  const { content, frame } = compiled.render(facts(input), null)
  const root = document.createElement('div')
  root.innerHTML = renderToStaticMarkup(<>{content}</>)
  return {
    metaRow: root.querySelector('[data-worktree-card-meta-row]'),
    indicators: root.querySelector('[data-part="Indicators"]'),
    singleLine: frame.singleLine
  }
}

describe('default workspace card layout', () => {
  it('keeps icons on the title line when the details row has nothing else to show', () => {
    const card = layout({ style: 'new' })
    expect(card.indicators).not.toBeNull()
    expect(card.metaRow).toBeNull()
    expect(card.singleLine).toBe(true)
  })

  it('puts icons in the details row beside the branch', () => {
    const card = layout({ style: 'new', branch: true })
    expect(card.metaRow?.contains(card.indicators)).toBe(true)
    expect(card.singleLine).toBe(false)
  })

  it('keeps icons on the title line with the details row off', () => {
    const card = layout({ style: 'new', detailsRow: false, branch: true })
    expect(card.indicators).not.toBeNull()
    expect(card.metaRow).toBeNull()
  })

  it('keeps classic cards drawing icons in the meta row', () => {
    const card = layout({ style: 'classic' })
    expect(card.metaRow?.contains(card.indicators)).toBe(true)
  })
})
