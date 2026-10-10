import fs from 'node:fs'

import { describe, expect, it } from 'vitest'
import ko from './locales/ko.json'

const correctedValues = {
  'auto.components.TaskPage.linearEmptyUnfilteredScope':
    '이 워크스페이스 범위에 이슈가 없습니다. 검색하거나 팀을 조정해 보세요.',
  'auto.components.floating.terminal.FloatingTerminalToggleButton.4cb418b991':
    '플로팅 워크스페이스 표시, 새 활동',
  'auto.components.linear-issue-attribute-filter-dropdowns.allWorkspacesBody':
    '상태, 담당자, 레이블 필터는 단일 Linear 워크스페이스의 ID를 사용합니다. 해당 속성으로 필터링할 워크스페이스 하나를 선택하세요.',
  'auto.components.linear-issue-attribute-filter-dropdowns.allWorkspacesTitle': '워크스페이스 선택',
  'auto.components.linear-issue-attribute-filter-dropdowns.teamRequired':
    '이 워크스페이스의 상태, 담당자, 레이블을 로드하려면 팀을 선택하세요.',
  'auto.components.right.sidebar.source.control.ai.push.failure.launch.216f762bd7':
    '워크스페이스 연결을 확인할 수 없습니다.',
  'auto.components.right.sidebar.source.control.ai.recovery.launch.216f762bd7':
    '워크스페이스 연결을 확인할 수 없습니다.',
  'auto.components.settings.LinearAgentSkillGuide.noteLinkedBody':
    '작업에서 만든 워크트리는 이슈가 컨텍스트로 연결되어 있어 이슈 작업이 가장 원활합니다.',
  'auto.components.settings.LinearAgentSkillPane.howToUseDescription':
    '카드를 클릭해 프롬프트를 복사하세요. 스킬을 설치한 후 Linear에 연결된 워크트리에서 사용하세요.',
  'auto.components.shared.useDaemonActions.a702d4196e':
    '이 작업은 모든 워크스페이스의 모든 터미널 탭을 닫고 현재 터미널 세션의 종료를 요청합니다. 저장되지 않은 터미널 작업은 손실됩니다. 데몬 자체는 계속 실행되며 새 터미널은 즉시 열 수 있습니다. 이 작업은 되돌릴 수 없습니다.',
  'auto.components.sidebar.ForgetSshWorkspaceDialog.disconnectedBody':
    '이 워크스페이스의 SSH 호스트가 연결되어 있지 않습니다. 재연결하여 원격에서도 삭제하거나 Orca에서만 제거하세요.',
  'auto.components.sidebar.HostRemoveDialog.manyWorkspaces': '워크스페이스 {{count}}개',
  'auto.components.sidebar.HostRemoveDialog.oneWorkspace': '워크스페이스 1개',
  'auto.components.sidebar.HostRemoveDialog.workspacesFailed':
    '이 호스트에서 워크스페이스 {{count}}개를 제거할 수 없었습니다. 재시도할 수 있도록 호스트가 유지되었습니다.',
  'auto.components.sidebar.WorktreeContextMenu.8d9cd19d09': '상위 워크트리 열기',
  'auto.components.sidebar.WorktreeList.failedUnnestWorkspace': '워크스페이스 펼치기 실패',
  'auto.components.sidebar.delete.worktree.toast.locked':
    '이 워크스페이스는 Git에 의해 잠겨 있습니다. 저장소에서 git worktree unlock <worktree-path>을 실행한 후 삭제를 다시 시도하세요.',
  'auto.components.sidebar.delete.worktree.toast.lockedReason':
    '이 워크스페이스는 Git에 의해 잠겨 있습니다. Git 보고: {{value0}}. 저장소에서 git worktree unlock <worktree-path>을 실행한 후 삭제를 다시 시도하세요.',
  'auto.components.tab.group.AiVaultSessionDropLayer.openSupportedWorkspace':
    '세션을 재개하기 전에 워크스페이스를 여세요.',
  'auto.components.terminal.pane.TerminalSshReconnectOverlay.removeWorkspaceButton':
    '워크스페이스 제거',
  'auto.components.terminal.pane.TerminalSshReconnectOverlay.removedBody':
    '이 워크스페이스의 SSH 호스트가 제거되어 더 이상 연결할 수 없습니다. 워크스페이스를 제거하여 정리하세요 — 원격 파일은 그대로 남아 있습니다.',
  'auto.lib.sidebarWorktreeActivation.wakeEphemeralVmFailed': '임시 VM 워크스페이스 활성화 실패',
  'auto.components.settings.AutoRenameBranchFromWorkSetting.d9b65054ef':
    ') 작업을 요약하는 짧은 이름으로 변경됩니다. Orca가 직접 이름 붙인 브랜치만 이름을 바꾸며, 푸시된 후에는 이름을 바꾸지 않습니다.',
  'auto.components.settings.source.control.action.recipe.options.commitMessage':
    '스테이징된 변경 사항에서 commit 메시지를 생성합니다.',
  'auto.components.settings.DevToolsPane.orcaCloudDescription':
    '자사 클라우드 로그인의 개발자 전용 미리보기. 프로덕션에서는 숨겨집니다. 개발 환경에서는 ORCA_CLOUD_API_URL과 ORCA_CLOUD_CLIENT_ID가 설정되면 사이드바 계정 전환기에도 표시됩니다.',
  'auto.components.settings.EphemeralVmsPane.whatTitle': '이 스킬로 함께 하는 작업',
  'auto.components.settings.EphemeralVmsPane.recipes': '레시피',
  'auto.components.right.sidebar.SourceControl.a5e5a11090':
    '모든 변경 사항 취소 실패 — 취소 전에 파일의 스테이징을 해제하지 못했습니다.',
  'auto.components.right.sidebar.SourceControl.6d7f2a47e5': '폴더의 변경 사항 취소',
  'auto.components.right.sidebar.source.control.discard.confirmation.40e9357b2a':
    '이렇게 하면 HEAD에서 파일을 복원하고 파일 삭제를 취소합니다. 이 작업은 취소할 수 없습니다.',
  'auto.components.right.sidebar.source.control.primary.action.5a477d80cb':
    '모든 변경 사항 스테이징',
  'auto.components.settings.DeveloperPermissionsPane.f903bf20b5':
    '터미널과 개발 도구가 로컬 네트워크의 서비스에 연결할 수 있도록 허용합니다. macOS는 이 권한의 현재 상태를 Orca에 보고하지 않습니다.',
  'auto.components.sidebar.AddRemoteHostDialog.sshImportSynced':
    '{{value0}} 호스트{{value1}}을(를) Orca에 추가했습니다.',
  'auto.components.editor.CheckRunJobs.1c0a4d7e02': '성공',
  'components.native-chat.approval.allow': '허용',
  'components.native-chat.approval.deny': '거부'
} as const

function getLocaleValue(path: string): unknown {
  return path.split('.').reduce<unknown>((node, segment) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      return undefined
    }
    return (node as Record<string, unknown>)[segment]
  }, ko)
}

describe('Korean UI semantic mistranslation fixes', () => {
  it('keeps the corrected values in the Korean catalog', () => {
    for (const [path, expected] of Object.entries(correctedValues)) {
      expect(getLocaleValue(path), path).toBe(expected)
    }
  })

  it('keeps the corrected values in the translation overrides', () => {
    const overrides = JSON.parse(
      fs.readFileSync(
        new URL('../../../../config/scripts/locale-ko-key-overrides.json', import.meta.url),
        'utf8'
      )
    ) as Record<string, { ko?: string }>

    for (const [path, expected] of Object.entries(correctedValues)) {
      expect(overrides[path]?.ko, path).toBe(expected)
    }
  })
})
