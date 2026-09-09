/**
 * Handing what the reader pointed at in a live preview to the agent.
 *
 * This is what makes the preview more than a viewer: `officecli` returns the selected elements as
 * stable `@id=`-style paths that survive edits, so a reference built from them still names the
 * right shapes after the agent rewrites the slide around them.
 *
 * The reference goes into the composer, not down the wire as a submitted prompt: the reader
 * pointed at something, they did not yet say what to do with it.
 */
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { deliverLaunchPromptToAgentTab } from '@/lib/agent-launch-prompt-delivery'
import { getActiveTerminalNoteTarget } from '@/lib/active-agent-note-target'
import { useAppStore } from '@/store'
import type { OfficeHostOwner } from '../../../shared/office-host-owner'
import type { OfficeSelectionNode } from '../../../shared/office-preview-contracts'

/** Enough elements to act on, few enough to stay readable in a composer. */
const MAX_REFERENCED_NODES = 20

/**
 * A compact, human-readable reference: the document, then one line per element with its path and
 * a short label. An agent can act on the paths; a person can read the labels and check the agent
 * changed what they meant.
 */
export function formatOfficeSelectionReference(
  documentPath: string,
  nodes: readonly OfficeSelectionNode[]
): string {
  const shown = nodes.slice(0, MAX_REFERENCED_NODES)
  const lines = shown.map((node) => {
    const label = node.text?.trim().replace(/\s+/g, ' ').slice(0, 60) ?? ''
    const kind = node.type ? ` (${node.type})` : ''
    return label ? `- ${node.path}${kind} — "${label}"` : `- ${node.path}${kind}`
  })
  if (nodes.length > shown.length) {
    lines.push(`- …and ${nodes.length - shown.length} more`)
  }
  return [`In ${documentPath}, I selected:`, ...lines].join('\n')
}

export type OfficeSelectionHandoff =
  | { status: 'composed' }
  | { status: 'copied' }
  | { status: 'empty' }
  | { status: 'failed'; code: string }

/**
 * Reads the live preview's selection and puts a reference where the reader can use it.
 *
 * Clipboard is the fallback, not a failure: with no agent tab open there is no composer to seed,
 * and dropping the reference on the floor after the reader deliberately selected something is the
 * worse outcome.
 */
export async function handOffOfficeSelection(params: {
  worktreeId: string
  owner: OfficeHostOwner
  filePath: string
}): Promise<OfficeSelectionHandoff> {
  const outcome = await window.api.office
    .selection({ owner: params.owner, path: params.filePath })
    .catch(() => ({ ok: false as const, code: 'OFFICE_HOST_UNREACHABLE' as const }))
  if (!outcome.ok) {
    return { status: 'failed', code: outcome.code }
  }
  if (outcome.nodes.length === 0) {
    return { status: 'empty' }
  }
  const reference = formatOfficeSelectionReference(params.filePath, outcome.nodes)
  const state = useAppStore.getState()
  const target = getActiveTerminalNoteTarget(state, params.worktreeId)
  const tab = target
    ? (state.tabsByWorktree[params.worktreeId] ?? []).find((row) => row.id === target.tabId)
    : undefined
  const agent = tab?.launchAgent
  if (target && agent) {
    // submit:false is the whole point — the reader still has to say what to do with the selection.
    const delivered = await deliverLaunchPromptToAgentTab({
      tabId: target.tabId,
      agent,
      content: reference,
      submit: false,
      forcePaste: true
    }).catch(() => false)
    if (delivered) {
      return { status: 'composed' }
    }
  }
  await window.api.ui.writeClipboardText(reference)
  return { status: 'copied' }
}

export function reportOfficeSelectionHandoff(result: OfficeSelectionHandoff): void {
  switch (result.status) {
    case 'composed':
      return
    case 'copied':
      toast.success(
        translate(
          'auto.lib.office.selection.copied',
          'Selection copied — paste it into the agent you want to act on it.'
        )
      )
      return
    case 'empty':
      toast.message(
        translate('auto.lib.office.selection.empty', 'Nothing is selected in the live preview yet.')
      )
      return
    case 'failed':
      toast.error(
        translate('auto.lib.office.selection.failed', 'Orca could not read the preview selection.')
      )
  }
}
