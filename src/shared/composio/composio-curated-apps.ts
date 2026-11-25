// The popular apps Add connector offers before a Composio key, drawn with no Composio call. Apps Orca
// connects itself (Slack, GitHub, Google, Linear, Discord) are left out, and so is any app Composio has
// no sign-in of its own for (checked against Composio's toolkits, 11-04).
/** `line` is the app's one-line summary in the bot's app list. */
export type ComposioCuratedApp = { slug: string; name: string; line: string }

export const COMPOSIO_CURATED_APPS: readonly ComposioCuratedApp[] = [
  { slug: 'outlook', name: 'Outlook', line: 'Mail, calendar and contacts' },
  { slug: 'microsoft_teams', name: 'Teams', line: 'Chats, channels and meetings' },
  { slug: 'notion', name: 'Notion', line: 'Pages, databases and comments' },
  { slug: 'jira', name: 'Jira', line: 'Issues, projects and sprints' },
  { slug: 'hubspot', name: 'HubSpot', line: 'Contacts, companies, deals and tickets' },
  { slug: 'salesforce', name: 'Salesforce', line: 'Accounts, leads and opportunities' },
  { slug: 'asana', name: 'Asana', line: 'Tasks, projects and comments' },
  { slug: 'airtable', name: 'Airtable', line: 'Bases, tables and records' },
  { slug: 'zendesk', name: 'Zendesk', line: 'Tickets, users and help center articles' },
  { slug: 'figma', name: 'Figma', line: 'Files, comments and components' },
  { slug: 'stripe', name: 'Stripe', line: 'Payments, customers and invoices' },
  { slug: 'dropbox', name: 'Dropbox', line: 'Files and folders' },
  { slug: 'one_drive', name: 'OneDrive', line: 'Files and folders' },
  { slug: 'confluence', name: 'Confluence', line: 'Pages, spaces and comments' },
  { slug: 'clickup', name: 'ClickUp', line: 'Tasks, lists and docs' },
  { slug: 'monday', name: 'Monday', line: 'Boards, items and updates' },
  { slug: 'intercom', name: 'Intercom', line: 'Conversations, contacts and articles' },
  { slug: 'zoom', name: 'Zoom', line: 'Meetings, recordings and transcripts' },
  { slug: 'calendly', name: 'Calendly', line: 'Events, invitees and booking links' },
  { slug: 'trello', name: 'Trello', line: 'Boards, lists and cards' },
  { slug: 'sentry', name: 'Sentry', line: 'Issues, events and releases' },
  { slug: 'box', name: 'Box', line: 'Files and folders' },
  { slug: 'miro', name: 'Miro', line: 'Boards, sticky notes and frames' },
  { slug: 'reddit', name: 'Reddit', line: 'Posts, comments and subreddits' }
]

/** The name Orca shows for an app: the curated one, else Composio's, else its slug. */
export function composioAppName(slug: string, fallback?: string): string {
  return COMPOSIO_CURATED_APPS.find((app) => app.slug === slug)?.name ?? fallback ?? slug
}

// Composio's own description fits a row when it is this short; most run to a paragraph.
const ONE_LINE = 90

/** An app's one-line summary: the curated one, else Composio's own when it is one line, else
 *  Composio's categories ("Email and calendar"). */
export function composioAppLine(
  slug: string,
  categories: readonly string[],
  description = ''
): string {
  const curated = COMPOSIO_CURATED_APPS.find((app) => app.slug === slug)?.line
  if (curated) {
    return curated
  }
  const own = description.trim().replace(/\.$/, '')
  if (own && own.length <= ONE_LINE && !own.includes('\n')) {
    return own
  }
  const names = [...new Set(categories.map((name) => name.trim().replace(/\bai\b/gi, 'AI')))]
    .filter(Boolean)
    .slice(0, 3)
  const last = names.pop()
  const joined = names.length > 0 ? `${names.join(', ')} and ${last}` : (last ?? '')
  return joined.charAt(0).toUpperCase() + joined.slice(1)
}
