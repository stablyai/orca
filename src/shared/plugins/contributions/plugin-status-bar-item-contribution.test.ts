import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from '../manifest/plugin-manifest'
import { pluginStatusBarItemPatchSchema } from './plugin-status-bar-item-contribution'
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

function issues(raw: unknown): string {
  const parsed = parsePluginManifest(raw)
  return parsed.ok ? '' : parsed.error
}

describe('contributes.statusBarItems', () => {
  it('refuses duplicate ids, unknown commands, icons and fields', () => {
    expect(
      issues(
        manifest([
          { id: 'a', text: 'x' },
          { id: 'a', text: 'y' }
        ])
      )
    ).toContain('duplicate statusBarItems id: a')
    expect(issues(manifest([{ id: 'a', command: 'demo.missing' }]))).toContain(
      'unknown contributed command: demo.missing'
    )
    expect(issues(manifest([{ id: 'a', icon: 'not-an-icon' }]))).not.toBe('')
    expect(issues(manifest([{ id: 'a', onPress: 'x' }]))).not.toBe('')
  })

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

  it('needs an engines floor that reads the field', () => {
    expect(issues(manifest([{ id: 'a', text: 'x' }], '>=1.4.247'))).toContain('1.4.248')
  })

  it('patches only display fields', () => {
    expect(pluginStatusBarItemPatchSchema.safeParse({ text: '4', visible: false }).success).toBe(
      true
    )
    expect(pluginStatusBarItemPatchSchema.safeParse({ command: 'demo.tasks' }).success).toBe(false)
  })
})
