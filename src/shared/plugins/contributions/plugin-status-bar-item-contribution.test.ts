import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from '../manifest/plugin-manifest'
import {
  buildPluginApprovalRequest,
  formatPluginApprovalMessage
} from '../approval/plugin-cli-approval'

function manifest(statusBarItems: unknown[], engines = '>=1.4.248') {
  return {
    manifestVersion: 2,
    execution: 'declarative',
    id: 'status-demo',
    name: 'Status demo',
    version: '1.0.0',
    engines: { orca: engines },
    contributes: {
      commands: [{ id: 'demo.tasks', title: 'Open tasks', action: 'view.tasks' }],
      statusBarItems
    }
  }
}

describe('contributes.statusBarItems', () => {
  it('lists items in the dev-load and inspect approval, and binds the fingerprint to them', () => {
    const subject = (items: unknown[]) => {
      const parsed = parsePluginManifest(manifest(items))
      if (!parsed.ok) {
        throw new Error(parsed.error)
      }
      return {
        pluginKey: 'dev:status-demo',
        manifest: parsed.manifest,
        consentFingerprint: 'c',
        contentIdentity: 'h',
        isDev: true
      }
    }
    const request = buildPluginApprovalRequest(
      subject([{ id: 'tasks', text: '3 open' }]),
      'dev-load'
    )
    expect(formatPluginApprovalMessage(request)).toContain('statusBarItems "3 open"')
    expect(
      buildPluginApprovalRequest(subject([{ id: 'tasks', text: '4 open' }]), 'dev-load')
        .approvalFingerprint
    ).not.toBe(request.approvalFingerprint)
  })
})
