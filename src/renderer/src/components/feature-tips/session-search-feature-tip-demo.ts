import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export type SessionSearchDemoRow = {
  agent: 'claude' | 'codex'
  title: string
  role: string
  /** Hit snippets use the index's [[match]] markers so the demo highlights like real results. */
  text: string
  messages: number
  age: string
}

export type SessionSearchDemoScene = { query: string; hits: SessionSearchDemoRow[] }

function assistantRole(t: Translate = translate): string {
  return t('featureTips.sessionSearch.demoRoleAssistant', 'Assistant')
}

function userRole(t: Translate = translate): string {
  return t('featureTips.sessionSearch.demoRoleUser', 'User')
}

/** What the panel lists before anything is typed. */
export function getSessionSearchDemoRecentRows(t: Translate = translate): SessionSearchDemoRow[] {
  return [
    {
      agent: 'claude',
      title: t('featureTips.sessionSearch.recent1Title', 'Tidy the settings sidebar'),
      role: assistantRole(t),
      text: t(
        'featureTips.sessionSearch.recent1Text',
        'Moved the search entries under Workflows and updated the tests.'
      ),
      messages: 42,
      age: t('featureTips.sessionSearch.ageMinutes', '12m')
    },
    {
      agent: 'codex',
      title: t('featureTips.sessionSearch.recent2Title', 'Bump the lockfile'),
      role: userRole(t),
      text: t(
        'featureTips.sessionSearch.recent2Text',
        'Update the dependencies and make sure the build still passes.'
      ),
      messages: 18,
      age: t('featureTips.sessionSearch.ageHours', '2h')
    },
    {
      agent: 'claude',
      title: t('featureTips.sessionSearch.recent3Title', 'Release notes draft'),
      role: assistantRole(t),
      text: t(
        'featureTips.sessionSearch.recent3Text',
        'Here is a first pass at the notes, grouped by area.'
      ),
      messages: 9,
      age: t('featureTips.sessionSearch.ageYesterday', '1d')
    }
  ]
}

export function getSessionSearchDemoScenes(t: Translate = translate): SessionSearchDemoScene[] {
  return [
    {
      query: t('featureTips.sessionSearch.demoQuery', 'login timeout'),
      hits: [
        {
          agent: 'claude',
          title: t('featureTips.sessionSearch.demoHit1Title', 'Fix flaky auth redirect'),
          role: assistantRole(t),
          text: t(
            'featureTips.sessionSearch.demoHit1Snippet',
            'Raised the [[login timeout]] to 30s and added a retry on the token refresh.'
          ),
          messages: 64,
          age: t('featureTips.sessionSearch.demoHit1Age', '3d')
        },
        {
          agent: 'codex',
          title: t('featureTips.sessionSearch.demoHit2Title', 'Session refresh after sleep'),
          role: userRole(t),
          text: t(
            'featureTips.sessionSearch.demoHit2Snippet',
            'Why does the [[login]] page hang after a [[timeout]] on wake?'
          ),
          messages: 27,
          age: t('featureTips.sessionSearch.demoHit2Age', '1w')
        },
        {
          agent: 'claude',
          title: t('featureTips.sessionSearch.demoHit3Title', 'Auth e2e hardening'),
          role: assistantRole(t),
          text: t(
            'featureTips.sessionSearch.demoHit3Snippet',
            'Added a test that covers the [[login timeout]] path end to end.'
          ),
          messages: 31,
          age: t('featureTips.sessionSearch.demoHit3Age', '2w')
        }
      ]
    },
    {
      query: t('featureTips.sessionSearch.demoQuery2', 'migration rollback'),
      hits: [
        {
          agent: 'codex',
          title: t('featureTips.sessionSearch.demoHit4Title', 'Orders table migration'),
          role: assistantRole(t),
          text: t(
            'featureTips.sessionSearch.demoHit4Snippet',
            'The [[rollback]] drops the new index first, then restores the old column.'
          ),
          messages: 53,
          age: t('featureTips.sessionSearch.demoHit4Age', '5d')
        },
        {
          agent: 'claude',
          title: t('featureTips.sessionSearch.demoHit5Title', 'Staging deploy failed'),
          role: userRole(t),
          text: t(
            'featureTips.sessionSearch.demoHit5Snippet',
            'Can you write a [[migration]] [[rollback]] plan before we retry?'
          ),
          messages: 22,
          age: t('featureTips.sessionSearch.demoHit5Age', '3w')
        },
        {
          agent: 'claude',
          title: t('featureTips.sessionSearch.demoHit6Title', 'Schema review notes'),
          role: assistantRole(t),
          text: t(
            'featureTips.sessionSearch.demoHit6Snippet',
            'Every [[migration]] here is reversible except the enum rename.'
          ),
          messages: 14,
          age: t('featureTips.sessionSearch.demoHit6Age', '1mo')
        }
      ]
    }
  ]
}
