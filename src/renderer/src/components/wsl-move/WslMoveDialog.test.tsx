import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type {
  WslMoveRefusalCode,
  WslMoveResult
} from '../../../../shared/wsl-move/wsl-move-driver-types'
import { wslMoveRefusalMessage } from './wsl-move-copy'
import { WslMovePreviewBody, type WslMovePreviewBodyProps } from './WslMovePreviewBody'
import { WslMoveProgressBody, wslMoveCancellable } from './WslMoveProgressBody'
import { WslMoveResultBody, wslMoveResultTitle } from './WslMoveResultBody'

const noop = (): void => undefined
const READY = {
  outcome: 'ready' as const,
  distro: 'Ubuntu',
  repoIds: ['api'],
  folderWorkspaceIds: ['notes'],
  changed: [],
  heldByHost: [],
  refused: [],
  blockers: []
}

function preview(overrides: Partial<WslMovePreviewBodyProps> = {}): string {
  return renderToStaticMarkup(
    <WslMovePreviewBody
      distro="Ubuntu"
      rows={[
        { kind: 'repo', id: 'api', name: 'api' },
        { kind: 'folder', id: 'notes', name: 'notes' }
      ]}
      selected={[{ kind: 'repo', id: 'api' }]}
      counts={{ projects: 1, workspaces: 2, terminals: 3, chats: 4 }}
      preview={READY}
      notMoving={[]}
      blockers={[]}
      onToggle={noop}
      onSkip={noop}
      onRecheck={noop}
      onStart={noop}
      onClose={noop}
      {...overrides}
    />
  )
}

function result(value: WslMoveResult, reload: 'idle' | 'checkpoint-refused' = 'idle'): string {
  return renderToStaticMarkup(
    <WslMoveResultBody
      distro="Ubuntu"
      result={value}
      blockers={[]}
      reload={reload}
      onReload={noop}
      onReview={noop}
      onClose={noop}
    />
  )
}

describe('preview', () => {
  it('says verbatim that chats stay, lists every project with a checkbox, and counts the selection', () => {
    const markup = preview()
    expect(markup).toContain(
      'Existing chats stay on this computer. New chats in this project start on the WSL host.'
    )
    expect(markup.match(/role="checkbox"/g)).toHaveLength(2)
    expect(markup).toContain('Folder')
    expect(markup).toContain('Projects: 1 · Workspaces: 2 · Terminals: 3 · Chats: 4')
    expect(markup).toContain('>Move 1 project</button>')
    expect(markup).not.toMatch(/disabled=""[^>]*>Move 1 project/)
  })

  it('cannot start while checking, with nothing selected, or with blockers', () => {
    expect(preview({ preview: null })).toContain('Checking the selected projects')
    expect(preview({ preview: null })).toMatch(/disabled=""[^>]*>Move 1 project/)
    expect(preview({ selected: [] })).toMatch(/disabled=""[^>]*>Move 0 projects/)
    const blocked = preview({
      blockers: [
        {
          blocker: {
            kind: 'agent-working',
            ids: ['t:1'],
            actions: ['wait', 'end', 'skip-project']
          },
          projects: [{ kind: 'repo', id: 'api', name: 'api' }]
        }
      ]
    })
    expect(blocked).toMatch(/disabled=""[^>]*>Move 1 project/)
    expect(blocked).toContain('An agent is working or waiting for an answer')
    expect(blocked).toContain('Leave api out of this move')
    expect(blocked).toContain('Check again')
  })

  it('offers no skip where main does not allow it', () => {
    const markup = preview({
      blockers: [
        {
          blocker: {
            kind: 'scrollback-too-large',
            ids: ['t:1', 't:2'],
            actions: ['clear-scrollback']
          },
          projects: [{ kind: 'repo', id: 'api', name: 'api' }]
        }
      ]
    })
    expect(markup).toContain('2 terminals have too much output history to move')
    expect(markup).not.toContain('out of this move')
  })

  it('lets a start settle an earlier unfinished move', () => {
    const markup = preview({ preview: { outcome: 'refused', code: 'wsl_move_already_in_flight' } })
    expect(markup).toContain('A move of Ubuntu is still finishing.')
    expect(markup).not.toMatch(/disabled=""[^>]*>Move 1 project/)
  })

  it('explains what is not moving and shows a refusal with its reasons', () => {
    const markup = preview({
      notMoving: [{ name: 'old', why: 'Already on the Ubuntu host.' }],
      preview: {
        outcome: 'refused',
        code: 'wsl_move_export_incomplete',
        reasons: ['1 draft can’t move with this project yet.']
      }
    })
    expect(markup).toContain('Already on the Ubuntu host.')
    expect(markup).toContain('can&#x27;t move yet')
    expect(markup).toContain('1 draft can’t move with this project yet.')
  })
})

describe('progress', () => {
  it('shows bytes while copying and allows cancel until the switch', () => {
    const markup = renderToStaticMarkup(
      <WslMoveProgressBody
        progress={{
          distro: 'Ubuntu',
          step: 'copying',
          bytesSent: 5 * 1024 * 1024,
          bytesTotal: 20 * 1024 * 1024
        }}
        cancel="idle"
        onCancel={noop}
      />
    )
    expect(markup).toContain('5.0 MB of 20 MB')
    expect(markup).toContain('data-state="active"')
    expect(markup).not.toMatch(/disabled=""[^>]*>Cancel move/)
  })

  it('disables cancel from the switch on, and says so', () => {
    expect(wslMoveCancellable(null)).toBe(true)
    expect(wslMoveCancellable({ distro: 'Ubuntu', step: 'copying' })).toBe(true)
    expect(wslMoveCancellable({ distro: 'Ubuntu', step: 'switching' })).toBe(false)
    expect(wslMoveCancellable({ distro: 'Ubuntu', step: 'finishing' })).toBe(false)
    const markup = renderToStaticMarkup(
      <WslMoveProgressBody
        progress={{ distro: 'Ubuntu', step: 'finishing' }}
        cancel="idle"
        onCancel={noop}
      />
    )
    expect(markup).toMatch(/disabled=""[^>]*>Cancel move/)
    expect(markup).toContain('Finishing')
    expect(markup).toContain('cannot be cancelled')
  })
})

describe('result', () => {
  it('asks for the reload, names automations still off, and points at the way back', () => {
    const moved: WslMoveResult = {
      outcome: 'moved',
      migrationId: 'm1',
      phase: 'retained',
      reloadRequired: true,
      automationsPending: ['a1', 'a2'],
      browserLoginsNotCopiedReason: 'no-stable-partition'
    }
    const markup = result(moved)
    expect(wslMoveResultTitle(moved, 'Ubuntu')).toBe('Moved to the Ubuntu host')
    expect(markup).toContain('Reload now')
    expect(markup).toContain('2 automations are off on the host for now')
    expect(markup).toContain('could not identify the host’s browser profile')
    expect(markup).not.toContain('no-stable-partition')
    expect(markup).toContain('Use on this computer again')
    expect(markup).not.toContain('Close')
  })

  it('shows a refused reload', () => {
    const markup = result(
      { outcome: 'moved', migrationId: 'm1', phase: 'retained', reloadRequired: true },
      'checkpoint-refused'
    )
    expect(markup).toContain('could not back up unsaved files')
  })

  it('says nothing was moved after a reset, and waits for the host when it may have committed', () => {
    const reset = result({ outcome: 'reset', migrationId: 'm1', detail: 'stage failed' })
    expect(wslMoveResultTitle({ outcome: 'reset', migrationId: 'm', detail: '' }, 'U')).toBe(
      'Nothing was moved'
    )
    expect(reset).toContain('everything was put back')
    expect(reset).toContain('Back to projects')
    const waiting = result({ outcome: 'waiting-for-host', migrationId: 'm1', detail: 'x' })
    expect(waiting).toContain('stay read-only here until it does')
    expect(waiting).not.toContain('Reload now')
  })

  it('has a plain message for every refusal code', () => {
    const codes: WslMoveRefusalCode[] = [
      'wsl_move_unavailable',
      'wsl_move_already_running',
      'wsl_move_already_in_flight',
      'wsl_move_nothing_new',
      'wsl_move_host_unavailable',
      'wsl_move_host_update_required',
      'wsl_move_terminals_blocked',
      'wsl_move_export_incomplete',
      'wsl_move_manifest_too_large',
      'wsl_move_pause_failed',
      'wsl_move_scope_changed',
      'wsl_move_cancelled',
      'wsl_move_finished_earlier_move'
    ]
    const messages = codes.map((code) =>
      wslMoveRefusalMessage({ outcome: 'refused', code }, 'Ubuntu')
    )
    expect(new Set(messages).size).toBe(codes.length)
    for (const message of messages) {
      expect(message).not.toMatch(/wsl_move|manifest|orcad|UNC/i)
    }
    expect(
      wslMoveRefusalMessage(
        { outcome: 'refused', code: 'wsl_move_manifest_too_large', message: 'Move fewer.' },
        'Ubuntu'
      )
    ).toBe('Move fewer.')
  })

  it('reloads, not closes, after an earlier move finished first', () => {
    const markup = result({ outcome: 'refused', code: 'wsl_move_finished_earlier_move' })
    expect(markup).toContain('Reload now')
    expect(markup).not.toContain('Back to projects')
  })
})

describe('entry points with the gate closed', () => {
  it('render nothing', async () => {
    vi.resetModules()
    vi.doMock('../sidebar/use-wsl-hosts-enabled', () => ({
      useWslHostsEnabled: () => false,
      useWslHostServerFilesMissing: () => false
    }))
    vi.doMock('@/store', () => ({
      useAppStore: (selector: (state: { runtimeEnvironments: unknown[] }) => unknown) =>
        selector({
          runtimeEnvironments: [
            {
              id: 'wsl:ubuntu',
              name: 'Ubuntu (WSL)',
              orcadDeployment: { kind: 'wsl', distro: 'Ubuntu', localPort: 1, remotePort: 2 }
            }
          ]
        })
    }))
    const { WslMoveProjectMenuItem } = await import('./WslMoveProjectMenuItem')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the item reads only path and the host fields.
    const repo = { id: 'api', path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\api' } as never
    expect(renderToStaticMarkup(<WslMoveProjectMenuItem repo={repo} />)).toBe('')
    vi.doUnmock('../sidebar/use-wsl-hosts-enabled')
    vi.doUnmock('@/store')
  })
})
