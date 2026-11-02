import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from '../manifest/plugin-manifest'
import { derivePluginExecutionProfile } from './plugin-execution-profile'
import { pluginStatusBarItemPatchSchema } from './plugin-status-bar-item-contribution'

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
  it('accepts a static item that runs one of the plugin commands', () => {
    const parsed = parsePluginManifest(
      manifest([
        { id: 'tasks', text: '3 open', icon: 'check', tone: 'warning', command: 'demo.tasks' }
      ])
    )
    expect(parsed.ok && parsed.manifest.contributes.statusBarItems).toEqual([
      { id: 'tasks', text: '3 open', icon: 'check', tone: 'warning', command: 'demo.tasks' }
    ])
  })

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

  it('needs an engines floor that reads the field', () => {
    expect(issues(manifest([{ id: 'a', text: 'x' }], '>=1.4.247'))).toContain('1.4.248')
  })

  it('needs only the declarative profile', () => {
    const parsed = parsePluginManifest(manifest([{ id: 'a', text: 'x' }]))
    expect(parsed.ok && derivePluginExecutionProfile(parsed.manifest)).toBe('declarative')
    expect(issues({ ...manifest([{ id: 'a', text: 'x' }]), execution: 'data' })).not.toBe('')
  })

  it('patches only display fields', () => {
    expect(pluginStatusBarItemPatchSchema.safeParse({ text: '4', visible: false }).success).toBe(
      true
    )
    expect(pluginStatusBarItemPatchSchema.safeParse({ command: 'demo.tasks' }).success).toBe(false)
  })
})
