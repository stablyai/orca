import type { BotTemplate } from '../bot-templates'

export const BOT_TEMPLATES_PLANNING: readonly BotTemplate[] = [
  {
    id: 'briefing',
    category: 'planning',
    name: 'Project briefing',
    line: 'A weekly brief on the projects you pick.',
    firstChat:
      'Writes what changed, what’s blocked and what needs a decision for the projects you pick.',
    mascot: 'G1',
    watches: 'Linear projects and GitHub repos',
    does: 'Writes what changed, what’s blocked and what needs a decision.',
    reports: 'Here, Fridays at 3 PM',
    connectors: ['github', 'linear'],
    schedules: [
      {
        id: 'weekly-brief',
        when: 'Fridays at 3 PM',
        what: 'The brief',
        rrule: '0 15 * * 5',
        prompt:
          'Write this week’s brief on the projects my owner picked with the status-brief skill: changed, blocked, needs a decision.'
      }
    ],
    events: [],
    skills: ['status-brief'],
    example: [
      'Mobile v2: 6 issues closed, 2 waiting on design.',
      'Needs a decision: ORC-902, push permission copy.'
    ]
  },
  {
    id: 'docs-upkeep',
    category: 'planning',
    name: 'Docs upkeep',
    line: 'Flags docs that no longer match merged code.',
    firstChat:
      'Reads last week’s merged pull requests and lists docs pages that now say something wrong.',
    mascot: 'L2',
    watches: 'Merged pull requests and the docs in the repos you pick',
    does: 'Lists docs pages that no longer match what merged, with the line that is now wrong.',
    reports: 'Here, Wednesdays at 10 AM',
    connectors: ['github'],
    schedules: [
      {
        id: 'weekly-docs',
        when: 'Wednesdays at 10 AM',
        what: 'Docs to update',
        rrule: '0 10 * * 3',
        prompt:
          'Read last week’s merged pull requests in the repos my owner picked and list docs pages that now say something wrong, with the page, the line and what changed.'
      }
    ],
    events: [],
    skills: [],
    example: [
      'docs/remote.md still says SSH needs a restart; #4108 removed that.',
      '1 more page mentions the old setting name.'
    ]
  },
  {
    id: 'spec-drafts',
    category: 'planning',
    name: 'Spec drafting',
    line: 'Turns a discussion into a short spec you can share.',
    firstChat:
      'Give it a Slack thread or a doc. It drafts a one-page spec and asks about anything left open.',
    mascot: 'T1',
    watches: 'Slack threads and docs you hand it',
    does: 'Drafts a one-page spec: problem, decision, scope, open questions.',
    reports: 'Here, when you ask',
    connectors: ['slack', 'google'],
    schedules: [],
    events: [],
    skills: ['spec-format'],
    example: [
      'Draft: “Bot sharing v2”. 3 decisions, 2 open questions.',
      'Saved to your Drive as a doc.'
    ]
  },
  {
    id: 'backlog-cleanup',
    category: 'planning',
    name: 'Backlog cleanup',
    line: 'Finds stale, duplicate and unowned issues.',
    firstChat:
      'Lists issues untouched for 60 days, likely duplicates and issues with no owner, for a team you pick.',
    mascot: 'P3',
    watches: 'Linear issues for the team you pick',
    does: 'Lists stale issues, likely duplicates and issues with no owner.',
    reports: 'Here, on the 1st of each month',
    connectors: ['linear'],
    schedules: [
      {
        id: 'monthly-list',
        when: '1st of each month at 9 AM',
        what: 'Cleanup list',
        rrule: '0 9 1 * *',
        prompt:
          'List the team’s Linear issues untouched for 60 days, likely duplicates (using the issue-triage skill) and issues with no owner. Change nothing until my owner says so.'
      }
    ],
    events: [],
    skills: ['issue-triage'],
    example: ['14 issues untouched since August.', 'ORC-511 and ORC-688 look like the same bug.']
  }
]
