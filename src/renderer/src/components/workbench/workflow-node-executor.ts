import { getRepoExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/rpc/targets/runtime-client-target'
import { invokeNative, isTauriNativeHost } from '@/web/tauri-native-host'
import {
  checkToolCommandAllowed,
  type HarnessPolicy
} from '../../../../shared/harness/harness-policy'
import { runCommitNodeHarnessCheck } from './harness-policy-io'
import type { WorkflowNodeDef } from './workflow-presets'

type RepoRef = Parameters<typeof getRepoExecutionHostId>[0] & {
  path?: string
  connectionId?: string | null
}

export async function executeWorkflowNode({
  node,
  worktreePath,
  reqText,
  repo,
  harnessPolicy,
  getNodeDesc
}: {
  node: WorkflowNodeDef
  worktreePath: string | undefined
  reqText: string
  repo: RepoRef | null | undefined
  harnessPolicy?: HarnessPolicy
  getNodeDesc: (node: WorkflowNodeDef) => string
}): Promise<{ ok: boolean; output: string }> {
  const targetDir = worktreePath ?? repo?.path
  const localDir = targetDir && isTauriNativeHost() && !repo?.connectionId ? targetDir : null
  const cliCommand =
    node.kind === 'cli'
      ? node.instruction?.trim()
      : node.kind === 'verify'
        ? node.instruction?.trim()
        : undefined
  if (node.kind === 'cli') {
    if (!cliCommand) {
      return { ok: false, output: 'CLI 节点未配置要执行的命令。' }
    }
    if (!localDir) {
      return { ok: false, output: 'CLI 节点需要本地项目目录和桌面宿主环境才能自动执行。' }
    }
  }
  if (cliCommand && localDir) {
    let warningPrefix = ''
    if (harnessPolicy) {
      const guard = checkToolCommandAllowed(cliCommand, harnessPolicy)
      if (!guard.allowed) {
        return { ok: false, output: guard.reason ?? 'Blocked by harness policy.' }
      }
      if (guard.severity === 'warn' && guard.reason) {
        warningPrefix = `[Harness warning] ${guard.reason}\n`
      }
    }
    const res = await invokeNative<{ passed: boolean; exitCode: number; output: string }>(
      'poc_run_workflow_command',
      {
        args: {
          workdir: localDir,
          command: cliCommand,
          shell: node.shell && node.shell !== 'auto' ? node.shell : undefined
        }
      }
    )
    return {
      ok: res.passed,
      output: `${warningPrefix}${res.output || `exit ${res.exitCode}`}`
    }
  }
  if (node.kind === 'verify' && worktreePath && repo) {
    const target = ipcOrRuntimeTargetForHostId(getRepoExecutionHostId(repo))
    if (target) {
      const res = await callRuntimeRpc<{ passed: boolean; output: string }>(
        target,
        'pipeline.gate.checkChanged',
        { workdir: worktreePath },
        { timeoutMs: 600_000 }
      )
      return {
        ok: res.passed,
        output: res.output || (res.passed ? 'Checks passed.' : 'Checks failed.')
      }
    }
  }
  if (node.kind === 'accept' && worktreePath && repo) {
    const target = ipcOrRuntimeTargetForHostId(getRepoExecutionHostId(repo))
    if (target) {
      const res = await callRuntimeRpc<{ verdict: 'pass' | 'needs_changes'; report: string }>(
        target,
        'pipeline.review.run',
        { workdir: worktreePath },
        { timeoutMs: 300_000 }
      )
      return {
        ok: res.verdict === 'pass',
        output: res.report || (res.verdict === 'pass' ? 'Accepted.' : 'Needs changes.')
      }
    }
  }
  let warningPrefix = ''
  if (node.kind === 'commit' && harnessPolicy && localDir) {
    const check = await runCommitNodeHarnessCheck(localDir, harnessPolicy)
    if (!check.ok) {
      return { ok: false, output: check.error ?? 'Blocked by harness policy.' }
    }
    if (check.warnings.length > 0) {
      warningPrefix = `${check.warnings.join('\n')}\n`
    }
  }
  const detail = node.instruction?.trim() || getNodeDesc(node)
  const agentTag = [node.agent, node.model].filter(Boolean).join(' · ')
  return {
    ok: true,
    output: `${warningPrefix}${agentTag ? `[${agentTag}] ` : ''}${detail} (${reqText.slice(0, 60)})`
  }
}
