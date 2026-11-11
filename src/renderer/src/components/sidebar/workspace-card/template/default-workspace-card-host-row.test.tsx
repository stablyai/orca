import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CARD_PRIMITIVES } from './card-primitives'
import { cardElement, compileCardTemplate } from './card-template-compiler'
import { DEFAULT_WORKSPACE_CARD_TEMPLATE } from './default-workspace-card'

// The default card's own vars, read through a probe that prints the two JA-13 decisions.
const probe = compileCardTemplate(
  {
    ...DEFAULT_WORKSPACE_CARD_TEMPLATE,
    defs: undefined,
    root: {
      el: 'Probe',
      props: { host: '=vars.hostLabel', identity: '=vars.identityInMeta' }
    }
  },
  {
    ...CARD_PRIMITIVES,
    Probe: cardElement<null>(['host', 'identity'], (props) => (
      <i>{`${String(props.host)}|${String(props.identity)}`}</i>
    ))
  }
)

function facts(host: { kind: string; contextLabel: string | null }, title: string) {
  return {
    ws: {
      id: 'w',
      name: title,
      title,
      kind: 'git',
      path: '/p',
      branch: 'ja-hello',
      identity: 'ja-hello',
      isMain: false,
      isSparse: false,
      detachedHead: false,
      comment: ''
    },
    repo: { id: 'r', name: 'Hello-World', ssh: false },
    host: { ...host, runtimeDisconnected: false },
    git: { conflictOperation: null, remoteBranchConflict: null, cacheTimerActive: false },
    review: null,
    links: { count: 0, issue: false, linearIssue: false, jiraIssue: false },
    provenance: { automation: false, cli: false },
    ports: { count: 0 },
    lineage: { childCount: 0, collapsed: false, toggleable: false },
    place: {
      isActive: false,
      inPinnedSection: false,
      hideRepoBadge: false,
      showProjectName: false,
      affiliateList: false,
      deleteQuickAction: false
    },
    options: {
      style: 'new',
      show: {
        host: true,
        branch: true,
        status: true,
        ports: true,
        issue: true,
        linearIssue: true,
        jiraIssue: true,
        pr: true,
        comment: true,
        automation: true,
        cli: true,
        inlineAgents: false
      },
      agentRows: 'full'
    },
    env: { projectGroups: false }
  }
}

const read = (f: ReturnType<typeof facts>): string =>
  renderToStaticMarkup(<>{probe.render(f, null).content}</>)

describe('default workspace card host row (JA-13)', () => {
  it('names the host only on the exception: Orca Cloud yes, this computer no', () => {
    expect(read(facts({ kind: 'runtime', contextLabel: 'Orca Cloud' }, 'x'))).toContain(
      'Orca Cloud|'
    )
    expect(read(facts({ kind: 'local', contextLabel: 'Local Mac' }, 'x'))).toContain('null|')
  })

  it('does not repeat the name as the branch line', () => {
    expect(read(facts({ kind: 'runtime', contextLabel: 'Orca Cloud' }, 'ja-hello'))).toContain(
      '|false'
    )
    expect(read(facts({ kind: 'runtime', contextLabel: 'Orca Cloud' }, 'Fix login'))).toContain(
      '|true'
    )
  })
})
