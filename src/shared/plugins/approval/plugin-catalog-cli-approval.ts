import { createHash } from 'node:crypto'
import { pluginRepositoryOrigin } from '../catalog/plugin-repository-link'
import { PLUGIN_APPROVAL_REQUIRED_CODE, PLUGIN_APPROVAL_STALE_CODE } from './plugin-cli-approval'

/** Adding a catalog widens what Orca installs by name and auto-updates, so it needs `--approve` too. */

export type PluginCatalogApprovalRequest = {
  kind: 'catalog'
  catalog: { url: string; ref: string; owner: string | null; repository: string | null }
  approvalFingerprint: string
  grants: string[]
  why: string
  approveFlag: string
  nextSteps: string[]
}

/** Bound to the exact URL and branch added, so approving one catalog never adds another. */
export function pluginCatalogApprovalFingerprint(source: { url: string; ref: string }): string {
  const canonical = JSON.stringify(['orca-plugin-catalog-approval-v1', source.url, source.ref])
  return `cat1-${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`
}

export function buildPluginCatalogApprovalRequest(source: {
  url: string
  ref: string
}): PluginCatalogApprovalRequest {
  const origin = pluginRepositoryOrigin(source.url)
  const approvalFingerprint = pluginCatalogApprovalFingerprint(source)
  const approveFlag = `--approve ${approvalFingerprint}`
  const owner = origin?.owner ?? null
  return {
    kind: 'catalog',
    catalog: { url: source.url, ref: source.ref, owner, repository: origin?.repository ?? null },
    approvalFingerprint,
    grants: [
      `Orca lists this catalog's plugins in Settings → Plugins, and \`orca plugin install <publisher.id>\` installs them by name.`,
      'With plugin auto-update on, Orca installs new versions of plugins you installed from it without asking, as long as they ask for no new access.',
      'Adding it installs and enables nothing by itself; each plugin that runs code still needs its own approval.'
    ],
    why: `A catalog decides which repositories Orca installs and updates plugins from. It is published by ${owner ?? 'its owner'}, not Orca, so only add it if you trust ${owner ?? 'its owner'}.`,
    approveFlag,
    nextSteps: [
      'Adding a catalog changes where Orca installs plugins from. Confirm with your user first unless they asked for exactly this catalog.',
      `To approve, run the same command again with ${approveFlag}`
    ]
  }
}

export function formatPluginCatalogApprovalMessage(
  request: PluginCatalogApprovalRequest,
  stale: boolean
): string {
  const { catalog } = request
  return [
    stale
      ? 'That fingerprint is not for this catalog URL and branch. Review the catalog below.'
      : `Adding the catalog ${catalog.repository ?? catalog.url} (${catalog.ref}) needs approval.`,
    `Publisher: ${catalog.owner ?? 'unknown'}. Source: ${catalog.url} (${catalog.ref}).`,
    'Approving it means:',
    ...request.grants.map((grant) => `- ${grant}`),
    `Why approval is needed: ${request.why}`,
    `Fingerprint: ${request.approvalFingerprint}`
  ].join('\n')
}

export class PluginCatalogApprovalRequiredError extends Error {
  readonly code: string
  readonly data: PluginCatalogApprovalRequest

  constructor(request: PluginCatalogApprovalRequest, stale = false) {
    super(formatPluginCatalogApprovalMessage(request, stale))
    this.name = 'PluginCatalogApprovalRequiredError'
    this.code = stale ? PLUGIN_APPROVAL_STALE_CODE : PLUGIN_APPROVAL_REQUIRED_CODE
    this.data = request
  }
}
