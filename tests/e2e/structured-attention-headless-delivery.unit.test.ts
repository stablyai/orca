import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'

it('loads and delivers actual host notifications in plain Node without Electron installed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-headless-attention-'))
  const bundle = join(directory, 'notification-host.cjs')
  try {
    await build({
      stdin: {
        resolveDir: process.cwd(),
        sourcefile: 'structured-attention-headless-notification.ts',
        contents: `
          import {createStructuredAttentionMobileDelivery} from './src/main/runtime/structured-agent-session-mobile-attention'
          import {RuntimeMobileNotificationController} from './src/main/runtime/runtime-mobile-notification-controller'
          import {getDefaultNotificationSettings} from './src/shared/notification-settings-defaults'
          const controller = new RuntimeMobileNotificationController()
          controller.configureDismissalStore(${JSON.stringify(join(directory, 'state'))})
          const events = []
          controller.onDispatched(event => events.push(event))
          const delivery = createStructuredAttentionMobileDelivery({
            readNotificationSettings: getDefaultNotificationSettings,
            readWorkspaceLabels: () => ({worktreeLabel:'Notes'}),
            dispatch: event => controller.dispatch(event),
            reconcile: state => controller.reconcileStructuredPromptAttention(state),
            now: () => 60_000
          })
          const scope = {executionHostId:'local',wslDistro:null,workspaceId:'folder-a',workspaceKind:'folder'}
          const summary = {sessionId:'session-a',workspaceId:'folder-a',agent:'claude',status:'attention',updatedAt:1}
          delivery.deliver({
            type:'prompt',
            prompt:{scope,sessionId:'session-a',promptId:'approval-a',raisedAt:1,journalCursor:{epoch:'journal-a',sequence:1}}
          },summary)
          for (const outcome of ['failure','success']) {
            delivery.deliver({type:'completion',completion:{scope,sessionId:'session-a',turnId:outcome,outcome,completedAt:2}},summary)
          }
          console.log(JSON.stringify(events.map(({title,body,agentState}) => ({title,body,agentState}))))
        `
      },
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      external: ['electron'],
      outfile: bundle,
      logLevel: 'silent'
    })
    const result = await runProcess({
      program: process.execPath,
      args: [bundle],
      cwd: directory
    })

    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([
      { title: 'Notes - Claude needs input', body: 'Claude needs input.', agentState: 'blocked' },
      { title: 'Notes - Claude failed', body: 'Claude failed.', agentState: 'done' },
      { title: 'Notes - Claude finished', body: 'Claude finished.', agentState: 'done' }
    ])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
