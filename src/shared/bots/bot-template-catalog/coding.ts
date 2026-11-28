import type { BotTemplate } from '../bot-templates'

export const BOT_TEMPLATES_CODING: readonly BotTemplate[] = [
  {
    id: 'pr-review',
    category: 'coding',
    name: 'Pull request review',
    line: 'Reviews pull requests you’re asked to review and lists risky changes.',
    firstChat:
      'Asks which repos to cover, then reviews the open pull requests waiting on your review and posts its findings here, with file and line. It doesn’t comment on GitHub until you say it can.',
    mascot: 'B1',
    watches: 'Pull requests waiting on your review, in the repos you pick',
    does: 'Reviews each one and lists risky changes and missing tests, with file and line.',
    reports: 'Here, when a review is requested',
    connectors: ['github'],
    schedules: [],
    events: [
      {
        id: 'review-requested',
        name: 'When you’re asked to review a pull request: review it and post here',
        source: 'github',
        event: 'review_requested',
        prompt:
          'A pull request is waiting on my owner’s review. Review it with the pr-review-checklist skill and post the findings here, with file and line. Don’t comment on GitHub unless my owner said I can.'
      }
    ],
    skills: ['pr-review-checklist'],
    example: [
      '#4121: the retry counter is never reset, so a second outage stops retries.',
      'No test covers the new timeout path.'
    ]
  },
  {
    id: 'open-code-review',
    category: 'coding',
    name: 'OpenCodeReview',
    line: 'Review local changes or a pull request with OpenCodeReview (OCR).',
    firstChat:
      'Asks which Git workspace and changes to review. Uses your configured OCR model, or offers to review with the current agent if OCR has no model.',
    mascot: 'B1',
    watches: 'Only the workspace or pull request you ask about',
    does: 'Reviews the diff and reports findings with file and line, without changing your code.',
    reports: 'Here, when you ask for a review',
    connectors: [],
    schedules: [],
    events: [],
    skills: ['review-with-ocr'],
    needsSetup: 'Both modes need the ocr CLI and Git 2.41 or newer on the workspace host.',
    example: [
      'The retry handler drops the last failed request (src/queue.ts:42).',
      'One file was not reviewed; its diff exceeded the review budget.'
    ]
  },
  {
    id: 'bug-investigation',
    category: 'coding',
    name: 'Bug investigation',
    line: 'Reproduces a reported bug and finds where it starts.',
    firstChat:
      'Give it a bug report or an issue link. It starts an agent in a new workspace that writes down how to reproduce it, then reports the cause. It writes a fix only after you agree.',
    mascot: 'H1',
    watches: 'Bug reports you hand it, and Linear issues assigned to you',
    does: 'Reproduces the bug in a new workspace, finds where it starts, and proposes a fix.',
    reports: 'Here, when it has a repro and a cause',
    connectors: ['github', 'linear'],
    schedules: [],
    events: [
      {
        id: 'linear-assigned',
        name: 'When a Linear issue is assigned to you: investigate it',
        source: 'linear',
        event: 'assigned',
        prompt:
          'A Linear issue was assigned to my owner. If it is a bug, reproduce it with the bug-reproduction skill in a new workspace and report the steps and the cause here. Don’t start a fix until my owner agrees.'
      }
    ],
    skills: ['bug-reproduction'],
    example: [
      'Reproduced ORC-640 on Windows: paste drops the last line when it has no newline.',
      'Cause: the paste end marker goes out before the final chunk. Start a fix?'
    ]
  },
  {
    id: 'dependency-updates',
    category: 'coding',
    name: 'Dependency updates',
    line: 'Checks for outdated and vulnerable packages and proposes upgrades.',
    firstChat:
      'Lists outdated and vulnerable packages in a repo you pick, most urgent first. After you agree, an agent opens one pull request per group.',
    mascot: 'M1',
    watches: 'Packages in the repos you pick',
    does: 'Lists advisories and outdated packages, most urgent first; upgrades one group per pull request once agreed.',
    reports: 'Here, Mondays at 9 AM',
    connectors: ['github'],
    schedules: [
      {
        id: 'weekly-check',
        when: 'Mondays at 9 AM',
        what: 'New advisories and major versions',
        rrule: '0 9 * * 1',
        prompt:
          'Check the repos my owner picked for new security advisories and new major versions since last week. List them here, most urgent first, grouped the way the dependency-upgrade skill says.'
      }
    ],
    events: [],
    skills: ['dependency-upgrade'],
    example: [
      '1 advisory: http-client 6.19 has a high-severity fix in 6.21.',
      '4 minor upgrades can go in one pull request.'
    ]
  },
  {
    id: 'unreviewed-work',
    category: 'coding',
    name: 'Unreviewed agent work',
    line: 'A daily list of finished agent work nobody has looked at yet.',
    firstChat:
      'Lists workspaces whose agent finished with changes you haven’t reviewed or turned into a pull request. Orca already tells you when an agent is waiting on you; this covers what’s done.',
    mascot: 'K2',
    watches: 'Your Orca workspaces',
    does: 'Lists workspaces whose agent finished with changes nobody reviewed or opened a pull request for.',
    reports: 'Here, weekdays at 9 AM',
    connectors: [],
    schedules: [
      {
        id: 'daily-list',
        when: 'Weekdays at 9 AM',
        what: 'Finished work waiting for review',
        rrule: '0 9 * * 1-5',
        prompt:
          'List my owner’s workspaces whose agent finished with changes that have no pull request and no review yet, with the size of each diff and when it finished. Judge folder workspaces by activity only.'
      }
    ],
    events: [],
    skills: [],
    example: [
      'mobile-pairing finished yesterday with a 340-line diff, no pull request.',
      '2 more finished this week.'
    ]
  },
  {
    id: 'workspace-cleanup',
    category: 'coding',
    name: 'Workspace cleanup',
    line: 'Finds finished or abandoned workspaces and offers to remove them.',
    firstChat:
      'Lists workspaces whose pull request merged or that haven’t changed in two weeks, with any uncommitted changes. It removes only the ones you pick.',
    mascot: 'J1',
    watches: 'Your Orca workspaces and their pull requests',
    does: 'Lists workspaces that are done or abandoned, with uncommitted changes; removes only the ones you pick.',
    reports: 'Here, Fridays at 4 PM',
    connectors: ['github'],
    schedules: [
      {
        id: 'weekly-list',
        when: 'Fridays at 4 PM',
        what: 'Workspaces ready to remove',
        rrule: '0 16 * * 5',
        prompt:
          'List my owner’s workspaces that look done or abandoned, using the workspace-hygiene skill, with anything uncommitted or unpushed. Remove nothing until my owner picks.'
      }
    ],
    events: [],
    skills: ['workspace-hygiene'],
    example: [
      '6 workspaces are done: their pull requests merged this week.',
      '2 folders haven’t changed since Oct 20.'
    ]
  },
  {
    id: 'security-check',
    category: 'coding',
    name: 'Security check',
    line: 'Looks at merged changes for leaked secrets and risky code.',
    firstChat:
      'Reviews last week’s merged pull requests in a repo you pick and lists anything that needs a second look, with file and line.',
    mascot: 'N1',
    watches: 'Merged pull requests in the repos you pick',
    does: 'Checks them for leaked secrets, injection, missing auth and unsafe defaults.',
    reports: 'Here, Mondays at 9 AM and when a pull request merges',
    connectors: ['github'],
    schedules: [
      {
        id: 'weekly-review',
        when: 'Mondays at 9 AM',
        what: 'The week’s merged changes',
        rrule: '0 9 * * 1',
        prompt:
          'Review last week’s merged pull requests in the repos my owner picked with the security-checklist skill. List anything that needs a second look, with file and line, or say nothing was found.'
      }
    ],
    events: [
      {
        id: 'pr-merged',
        name: 'When a pull request merges: check it',
        source: 'github',
        event: 'pr_merged',
        prompt:
          'A pull request merged. Check it with the security-checklist skill and post anything that needs a second look here, with file and line. Stay quiet if nothing does.'
      }
    ],
    skills: ['security-checklist'],
    example: [
      '#4133 logs the full request headers, including the auth token.',
      'Nothing else this week.'
    ]
  }
]
