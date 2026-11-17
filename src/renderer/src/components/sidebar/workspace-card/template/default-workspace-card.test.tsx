// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CardTemplateNode } from '../../../../../../shared/workspace-cards/card-template-schema'
import type { WorkspaceCardFacts } from '../../../../../../shared/workspace-cards/workspace-card-facts'
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

function facts({ links, detailsRow }: { links: number; detailsRow: boolean }): WorkspaceCardFacts {
  return {
    ws: {
      id: 'wt-1',
      name: 'sample-workspace',
      title: 'sample-workspace',
      kind: 'git',
      path: '/repo/sample-workspace',
      branch: 'sample-workspace',
      identity: 'sample-workspace',
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
    links: { count: links, issue: false, linearIssue: false, jiraIssue: false },
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
      style: 'new',
      show: {
        status: true,
        unread: true,
        ci: true,
        branch: false,
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

/** The title line's children that take an auto left margin, by the part each one holds. */
function pushedTitleGroups(input: { links: number; detailsRow: boolean }): string[] {
  const { content } = compiled.render(facts(input), null)
  const root = document.createElement('div')
  root.innerHTML = renderToStaticMarkup(<>{content}</>)
  const titleLine = root.querySelector('[data-part="TitleStatus"]')?.parentElement?.parentElement
  expect(titleLine).toBeTruthy()
  return [...titleLine!.children]
    .filter((child) => child.classList.contains('ml-auto'))
    .map((child) => child.querySelector('[data-part]')?.getAttribute('data-part') ?? '')
}

describe('default workspace card title line', () => {
  // Why: two auto margins split the free space, so the icons drifted with title length
  // instead of sitting in one column beside the time.
  it.each([true, false])(
    'pushes only the icon group right so it stays beside the time (details row %s)',
    (detailsRow) => {
      expect(pushedTitleGroups({ links: 1, detailsRow })).toEqual(['Indicators'])
    }
  )

  it('pushes the time right when the card has no icons', () => {
    expect(pushedTitleGroups({ links: 0, detailsRow: true })).toEqual(['TitleStatus'])
  })
})
