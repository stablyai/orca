import type { WorkflowNodeKind } from './workflow-presets'

export type WorkflowNodeTemplate = { label: string; description: string; instruction: string }

export type TemplateTranslator = (key: string, defaultValue: string) => string

export function getDefaultNodeTemplate(
  kind: WorkflowNodeKind,
  t: TemplateTranslator
): WorkflowNodeTemplate {
  switch (kind) {
    case 'analyze':
      return {
        label: t('auto.components.workbench.flow.tplAnalyzeLabel', '需求分析'),
        description: t('auto.components.workbench.flow.tplAnalyzeDesc', '拆解需求并定位目标文件'),
        instruction: '分析需求，定位相关文件与改动范围'
      }
    case 'implement':
      return {
        label: t('auto.components.workbench.flow.tplImplementLabel', '编码实现'),
        description: t('auto.components.workbench.flow.tplImplementDesc', '在工作区完成代码修改'),
        instruction: '按方案完成代码实现，保持简洁'
      }
    case 'verify':
      return {
        label: t('auto.components.workbench.flow.tplVerifyLabel', '校验测试'),
        description: t('auto.components.workbench.flow.tplVerifyDesc', '运行类型检查或测试命令'),
        instruction: 'pnpm tc:web'
      }
    case 'cli':
      return {
        label: t('auto.components.workbench.flow.tplCliLabel', 'CLI 命令'),
        description: t(
          'auto.components.workbench.flow.tplCliDesc',
          '执行本地 Shell 命令（不消耗模型）'
        ),
        instruction: 'pnpm exec oxlint'
      }
    case 'accept':
      return {
        label: t('auto.components.workbench.flow.tplAcceptLabel', 'Diff 验收'),
        description: t('auto.components.workbench.flow.tplAcceptDesc', '审查改动并确认通过'),
        instruction: '审查 git diff，确认无遗漏或回归风险'
      }
    case 'commit':
      return {
        label: t('auto.components.workbench.flow.tplCommitLabel', '规范提交'),
        description: t('auto.components.workbench.flow.tplCommitDesc', '按 Harness 规范提交变更'),
        instruction: '按仓库规范整理并提交本次变更'
      }
  }
}
