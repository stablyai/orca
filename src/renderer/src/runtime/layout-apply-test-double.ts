// Main's `layout.apply` for renderer tests that run with either build switch: each command goes
// through the RPC's schema, as main receives it, and is answered applied. A switch-off run sends none.
import type { z } from 'zod'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { LayoutApplyParams } from '../../../shared/rpc-contract/workspace-layout-params'
import type {
  LayoutApplyReply,
  LayoutCommand
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import { renameTabCommandsOf } from '../../../shared/workspace-layout/workspace-layout-commands'

export type AppliedLayoutCommand = z.infer<typeof LayoutApplyParams>['command']

export function layoutApplyTestDouble(): {
  commands: AppliedLayoutCommand[]
  call: (request: {
    method: string
    params?: unknown
  }) => Promise<RuntimeRpcResponse<LayoutApplyReply>>
} {
  const commands: AppliedLayoutCommand[] = []
  return {
    commands,
    // Only layout commands parse: any other call fails the test.
    call: async ({ params }) => {
      commands.push(LayoutApplyParams.parse(params).command)
      return {
        id: 'layout-apply',
        ok: true,
        result: { ok: true, result: {} },
        _meta: { runtimeId: 'local' }
      }
    }
  }
}

/** A sent command as the model commands main applies: a `renameTabs` is a `renameTab` per title. */
export function layoutCommandsOf(command: AppliedLayoutCommand): LayoutCommand[] {
  return command.type === 'renameTabs' ? renameTabCommandsOf(command) : [command]
}
